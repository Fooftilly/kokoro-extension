/** @jest-environment node */
import { manifestForVariant, listModelVariants } from '../model-catalog.js';
import { validateModelManifest } from '../model-data-store.js';
import { tokenizePhonemes, PHONEME_VOCAB } from '../phoneme-tokenizer.js';
import { encodePcm16Wav } from '../pcm-wav.js';
import { MediaPipeKokoroProvider } from '../mediapipe-provider.js';
import { OnnxKokoroProvider } from '../onnx-provider.js';

function browserApi() {
    return { runtime: { getURL: path => 'moz-extension://test-uuid/' + (path.startsWith('/') ? path.slice(1) : path) } };
}

function fakeCache(manifest) {
    const contents = new Map();
    for (const asset of manifest.assets) {
        const key = 'https://kokoro-model-cache.invalid/model-data/' +
            manifest.provider + '/' + manifest.revision + '/' + manifest.variant + '/' + asset.path;
        contents.set(key, new Response(new Uint8Array(asset.bytes), {
            headers: {
                'x-kokoro-integrity': asset.integrity,
                'x-kokoro-bytes': String(asset.bytes),
            },
        }));
    }
    const cache = { match: jest.fn(async key => contents.get(key)) };
    return { open: jest.fn(async () => cache) };
}

describe('pinned official local Kokoro model catalog', () => {
    test('includes both MediaPipe variants and ONNX data without executable runtime assets', () => {
        const variants = listModelVariants();
        expect(variants.map(x => x.key)).toEqual([
            'mediapipe-cpu', 'mediapipe-gpu', 'onnx-q8', 'onnx-q8f16',
        ]);
        expect(validateModelManifest(manifestForVariant('mediapipe', 'cpu'))).toBe(294783298);
        expect(validateModelManifest(manifestForVariant('mediapipe', 'gpu'))).toBe(294750530);
        expect(validateModelManifest(manifestForVariant('onnx', 'q8'))).toBe(92361116 + 524288);
        expect(validateModelManifest(manifestForVariant('onnx', 'q8f16'))).toBe(86033585 + 524288);
        expect(manifestForVariant('onnx', 'q8').assets.every(a =>
            !/\\.(?:js|wasm)$/.test(a.path) && a.integrity.startsWith('sha256-'))).toBe(true);
        expect(() => manifestForVariant('fastapi', 'q8')).toThrow();
    });
    test('SRI values match the independently published SHA-256 digests', () => {
        const a = manifestForVariant('onnx', 'q8').assets[0];
        expect(a.integrity).toBe('sha256-' + Buffer.from(
            'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478', 'hex'
        ).toString('base64'));
    });
});

describe('original Kokoro phoneme and PCM adapters', () => {
    test('maps published phoneme vocabulary data without silently accepting unknown text', () => {
        expect(PHONEME_VOCAB.a).toBe(43);
        expect(tokenizePhonemes('a b')).toEqual([43, 16, 44]);
        expect(() => tokenizePhonemes('🚫')).toThrow(/Unknown Kokoro phoneme/);
        expect(() => tokenizePhonemes('')).toThrow();
    });
    test('encodes finite mono samples to standard PCM WAV with clipping', () => {
        const wav = encodePcm16Wav(new Float32Array([-1.2, 0, 1.2]), 24000);
        const view = new DataView(wav.buffer);
        expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe('RIFF');
        expect(Buffer.from(wav.subarray(8, 12)).toString()).toBe('WAVE');
        expect(view.getUint32(24, true)).toBe(24000);
        expect(view.getUint32(40, true)).toBe(6);
        expect(view.getInt16(44, true)).toBe(-32768);
        expect(view.getInt16(48, true)).toBe(32767);
        expect(() => encodePcm16Wav(new Float32Array([NaN]))).toThrow();
    });
});

describe('official packaged backend adapters — SDK mocks, no fake inference claim', () => {
    test('MediaPipe refuses inference before explicit model install and never fetches a remote URL', async () => {
        const fetchImpl = jest.fn();
        const sdk = jest.fn();
        const provider = new MediaPipeKokoroProvider({
            browserApi: browserApi(), cacheStorage: { open: async () => ({ match: async () => null }) },
            fetchImpl, loadSDK: sdk,
        });
        await expect(provider.synthesize('Hello')).rejects.toThrow(/not installed/);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(sdk).not.toHaveBeenCalled();
    });
    test('MediaPipe passes packaged WASM path and cached binary to official SDK', async () => {
        const synthesize = jest.fn(async () => ({ samples: new Float32Array([0.1, -0.1]), sampleRateHz: 24000 }));
        const createFromOptions = jest.fn(async () => ({ synthesize }));
        const forAudioTasks = jest.fn(async () => ({ runtime: 'packed' }));
        const loadSDK = jest.fn(async () => ({
            FilesetResolver: { forAudioTasks }, TextToSpeech: { createFromOptions },
        }));
        const provider = new MediaPipeKokoroProvider({ browserApi: browserApi(), loadSDK,
            cacheStorage: fakeCache({ ...manifestForVariant('mediapipe', 'cpu'),
                assets: [{ ...manifestForVariant('mediapipe', 'cpu').assets[0], bytes: 4 }] }),
            fetchImpl: jest.fn() });
        provider.manifest.assets[0].bytes = 4;
        const result = await provider.synthesize('Hello');
        expect(result.sampleRateHz).toBe(24000);
        expect(forAudioTasks).toHaveBeenCalledWith('moz-extension://test-uuid/runtimes/mediapipe/wasm');
        expect(createFromOptions).toHaveBeenCalledWith({ runtime: 'packed' },
            expect.objectContaining({ baseOptions: expect.objectContaining({ delegate: 'CPU',
                modelAssetPath: expect.stringMatching(/^blob:/) }) }));
        expect(synthesize).toHaveBeenCalledWith('Hello', { voiceId: 'af_heart', speakingRate: 1 });
    });
    test('ONNX refuses uninstalled model and does not call SDK or fetch', async () => {
        const loadSDK = jest.fn(), fetchImpl = jest.fn();
        const provider = new OnnxKokoroProvider({
            browserApi: browserApi(), loadSDK, fetchImpl,
            cacheStorage: { open: async () => ({ match: async () => null }) },
        });
        await expect(provider.synthesizePhonemes('a b')).rejects.toThrow(/not installed/);
        await expect(provider.synthesize('Hello')).rejects.toThrow(/G2P validation/);
        expect(loadSDK).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    test('ONNX builds real graph input tensors through the injected official SDK contract', async () => {
        const manifest = manifestForVariant('onnx', 'q8');
        manifest.assets[0].bytes = 4;
        manifest.assets[1].bytes = 4096;
        const session = { outputNames: ['audio'], run: jest.fn(async () => ({
            audio: { data: new Float32Array([0.1, -0.2]), dims: [1, 2] },
        })) };
        const create = jest.fn(async () => session);
        class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
        const sdk = { env: { wasm: {} }, InferenceSession: { create }, Tensor };
        const provider = new OnnxKokoroProvider({ browserApi: browserApi(),
            cacheStorage: fakeCache(manifest), fetchImpl: jest.fn(), loadSDK: async () => sdk });
        provider.manifest = manifest;
        const result = await provider.synthesizePhonemes('a b');
        expect(result.sampleRateHz).toBe(24000);
        expect(sdk.env.wasm.numThreads).toBe(1);
        expect(sdk.env.wasm.wasmPaths).toBe('moz-extension://test-uuid/runtimes/onnx/');
        expect(create).toHaveBeenCalledWith(expect.any(Uint8Array),
            expect.objectContaining({ executionProviders: ['wasm'] }));
        const input = session.run.mock.calls[0][0];
        expect(input.input_ids.type).toBe('int64');
        expect(Array.from(input.input_ids.data)).toEqual([0n, 43n, 16n, 44n, 0n]);
    });
});
