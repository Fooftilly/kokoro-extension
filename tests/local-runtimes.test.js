/** @jest-environment node */
import { manifestForVariant, listModelVariants, dictionaryManifest } from '../model-catalog.js';
import { ModelDataStore, validateModelManifest } from '../model-data-store.js';
import { tokenizePhonemes, PHONEME_VOCAB } from '../phoneme-tokenizer.js';
import { parseEnglishLexicon, phonemizeEnglish, loadCachedEnglishLexicon } from '../english-g2p.js';
import { encodePcm16Wav, validateKokoroPcm } from '../pcm-wav.js';
import { createHash, webcrypto } from 'node:crypto';
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
        const bytes = new Uint8Array(asset.bytes); // Original, tiny test fixture.
        // Both local backends check the bytes before inference; tiny mock
        // fixtures must carry a digest for their actual zero-filled contents.
        // The dictionary's real upstream checksum remains unchanged.
        if (manifest.provider === 'onnx' || manifest.provider === 'mediapipe') {
            asset.integrity = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
        }
        contents.set(key, new Response(bytes, {
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
    test('offers MediaPipe CPU and ONNX; GPU pin exists but is not listed until verified', () => {
        const variants = listModelVariants();
        expect(variants.map(x => x.key)).toEqual([
            'mediapipe-cpu', 'onnx-q8', 'onnx-q8f16',
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
    test('requires finite and non-silent PCM before a local engine can be validated', () => {
        expect(validateKokoroPcm(new Float32Array([0.1, -0.2]), 24000).rms)
            .toBeGreaterThan(0.0001);
        expect(() => validateKokoroPcm(new Float32Array([0, 0]), 24000))
            .toThrow(/silent/);
        expect(() => validateKokoroPcm(new Float32Array([0.000001]), 24000))
            .toThrow(/silent/);
        expect(() => validateKokoroPcm(new Float32Array([NaN]), 24000))
            .toThrow(/finite/);
        expect(() => validateKokoroPcm(new Float32Array([Infinity]), 24000))
            .toThrow(/finite/);
        expect(() => validateKokoroPcm(new Float32Array([0.1]), 16000))
            .toThrow(/24-kHz/);
        expect(() => validateKokoroPcm(new Float32Array([0.1]), undefined))
            .toThrow(/24-kHz/);
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

describe('original strict English dictionary phonemizer', () => {
    const data = 'hello HH AH0 L OW1\nworld W ER1 L D\n';
    const lexicon = parseEnglishLexicon(data);
    test('ignores inline CMUdict comments rather than treating them as phonemes', () => {
        const annotated = parseEnglishLexicon('gdp JH IY1 D IY1 P IY1 # initialism\\n');
        expect(annotated.get('gdp')).toBe('JH IY1 D IY1 P IY1');
        expect(() => phonemizeEnglish('GDP.', annotated)).not.toThrow();
    });
    test('converts CMUdict pronunciation data to Kokoro IPA', () => {
        const ipa = phonemizeEnglish('Hello world.', lexicon);
        expect(ipa).toBe('həlˈoʊ wˈɚld.');
        expect(tokenizePhonemes(ipa).length).toBeGreaterThan(4);
    });
    test('rejects unknown words, digits, unsupported Unicode and long input', () => {
        expect(() => phonemizeEnglish('unknown', lexicon)).toThrow(/Missing English pronunciation/);
        expect(() => phonemizeEnglish('hello 123', lexicon)).toThrow(/Unsupported English text/);
        expect(() => phonemizeEnglish('hello 😀', lexicon)).toThrow(/Unsupported English text/);
        expect(() => phonemizeEnglish('hello '.repeat(130), lexicon)).toThrow(/at most 510/);
    });
    test('the dictionary is a separate pinned download, not a bundled source file', () => {
        const manifest = dictionaryManifest();
        expect(manifest.provider).toBe('dictionary');
        expect(manifest.assets[0].bytes).toBe(3618488);
        expect(manifest.assets[0].integrity).toMatch(/^sha256-/);
        expect(manifest.assets[0].url).toBe(
            'https://raw.githubusercontent.com/cmusphinx/cmudict/' +
            manifest.revision + '/cmudict.dict');
    });
    test('does not download pronunciation data implicitly during synthesis', async () => {
        const manifest = dictionaryManifest();
        const store = fakeCache(manifest);
        const original = await store.open();
        const contents = data;
        original.match.mockImplementation(async () => new Response(contents, {
            headers: {
                'x-kokoro-integrity': manifest.assets[0].integrity,
                'x-kokoro-bytes': String(manifest.assets[0].bytes),
            },
        }));
        const fetcher = jest.fn();
        // This test checks offline loading, not checksum verification: its
        // abbreviated fixture cannot match the pinned 3.6-MB dictionary digest.
        const verified = jest.spyOn(ModelDataStore.prototype, 'cachedBytesMatch')
            .mockResolvedValue(true);
        try {
            const words = await loadCachedEnglishLexicon(browserApi(), store, fetcher);
            expect(words.size).toBe(2);
            expect(phonemizeEnglish('Hello world.', words)).toContain('ʊ');
        } finally {
            verified.mockRestore();
        }
        expect(fetcher).not.toHaveBeenCalled();
    });
    test('fails closed when dictionary has not been downloaded', async () => {
        const fetcher = jest.fn();
        await expect(loadCachedEnglishLexicon(browserApi(), {
            open: async () => ({ match: async () => null }),
        }, fetcher)).rejects.toThrow(/Download it in the TTS model manager/);
        expect(fetcher).not.toHaveBeenCalled();
    });
});

describe('official packaged backend adapters — SDK mocks, no fake inference claim', () => {
    const oldCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    beforeAll(() => {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    });
    afterAll(() => {
        if (oldCrypto) Object.defineProperty(globalThis, 'crypto', oldCrypto);
        else delete globalThis.crypto;
    });
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
        const manifest = manifestForVariant('mediapipe', 'cpu');
        manifest.assets[0].bytes = 4;
        manifest.assets[0].integrity = 'sha256-' +
            createHash('sha256').update(new Uint8Array(4)).digest('base64');
        const provider = new MediaPipeKokoroProvider({ browserApi: browserApi(), loadSDK,
            cacheStorage: fakeCache(manifest), fetchImpl: jest.fn() });
        provider.manifest = manifest;
        const result = await provider.synthesize('Hello');
        expect(result.sampleRateHz).toBe(24000);
        expect(forAudioTasks).toHaveBeenCalledWith('moz-extension://test-uuid/runtimes/mediapipe/wasm');
        expect(createFromOptions).toHaveBeenCalledWith({ runtime: 'packed' },
            expect.objectContaining({ cacheDirectory: ':nocache',
                baseOptions: expect.objectContaining({ delegate: 'CPU',
                    modelAssetPath: expect.stringMatching(/^blob:/) }) }));
        expect(synthesize).toHaveBeenCalledWith('Hello', { voiceId: 'af_heart', speakingRate: 1 });
    });
    test('MediaPipe initializes from cached Blob without allocating a second typed-array copy', async () => {
        const manifest = manifestForVariant('mediapipe', 'cpu');
        manifest.assets[0].bytes = 4;
        const asset = manifest.assets[0];
        asset.integrity = 'sha256-' +
            createHash('sha256').update(new Uint8Array(4)).digest('base64');
        const response = {
            headers: new Headers({
                'x-kokoro-integrity': asset.integrity,
                'x-kokoro-bytes': String(asset.bytes),
            }),
            blob: jest.fn(async () => new Blob([new Uint8Array(4)])),
            arrayBuffer: jest.fn(() => { throw new Error('Unexpected full model copy'); }),
        };
        const createFromOptions = jest.fn(async () => ({
            synthesize: async () => ({
                samples: new Float32Array([0.1, -0.1]), sampleRateHz: 24000,
            }),
        }));
        const provider = new MediaPipeKokoroProvider({
            browserApi: browserApi(),
            cacheStorage: { open: async () => ({ match: async () => response }) },
            fetchImpl: jest.fn(),
            loadSDK: async () => ({
                FilesetResolver: { forAudioTasks: async () => ({}) },
                TextToSpeech: { createFromOptions },
            }),
        });
        provider.manifest = manifest;
        expect((await provider.synthesize('Hello')).sampleRateHz).toBe(24000);
        expect(response.blob).toHaveBeenCalledTimes(1);
        expect(response.arrayBuffer).not.toHaveBeenCalled();
        expect(createFromOptions).toHaveBeenCalledWith({}, expect.objectContaining({
            cacheDirectory: ':nocache',
        }));
    });
    test('MediaPipe rejects a missing sample rate even with valid PCM', async () => {
        const manifest = manifestForVariant('mediapipe', 'cpu');
        manifest.assets[0].bytes = 4;
        const sdk = {
            FilesetResolver: { forAudioTasks: async () => ({}) },
            TextToSpeech: { createFromOptions: async () => ({
                synthesize: async () => ({ samples: new Float32Array([0.2, -0.3]) }),
            }) },
        };
        const provider = new MediaPipeKokoroProvider({
            browserApi: browserApi(), cacheStorage: fakeCache(manifest),
            fetchImpl: jest.fn(), loadSDK: async () => sdk,
        });
        provider.manifest = manifest;
        await expect(provider.synthesize('Hello')).rejects.toThrow(/24-kHz/);
    });
    test('MediaPipe cannot mark an installed model as working when SDK outputs silence', async () => {
        const manifest = manifestForVariant('mediapipe', 'cpu');
        manifest.assets[0].bytes = 4;
        const synthesize = jest.fn(async () => ({
            samples: new Float32Array(1024), sampleRateHz: 24000,
        }));
        const sdk = {
            FilesetResolver: { forAudioTasks: async () => ({}) },
            TextToSpeech: { createFromOptions: async () => ({ synthesize }) },
        };
        const provider = new MediaPipeKokoroProvider({
            browserApi: browserApi(), cacheStorage: fakeCache(manifest),
            fetchImpl: jest.fn(), loadSDK: async () => sdk,
        });
        provider.manifest = manifest;
        await expect(provider.synthesize('Hello')).rejects.toThrow(/silent/);
        expect(synthesize).toHaveBeenCalledTimes(1);
    });
    test('ONNX refuses uninstalled model and does not call SDK or fetch', async () => {
        const loadSDK = jest.fn(), fetchImpl = jest.fn();
        const provider = new OnnxKokoroProvider({
            browserApi: browserApi(), loadSDK, fetchImpl,
            cacheStorage: { open: async () => ({ match: async () => null }) },
        });
        await expect(provider.synthesizePhonemes('a b')).rejects.toThrow(/not installed/);
        await expect(provider.synthesize('Hello')).rejects.toThrow(/not installed/);
        expect(loadSDK).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    test('ONNX sends text-derived phoneme tokens to the official session', async () => {
        const manifest = manifestForVariant('onnx', 'q8');
        manifest.assets[0].bytes = 4;
        // Allocate enough style rows to cover the full English test phrase.
        manifest.assets[1].bytes = 65536;
        const run = jest.fn(async () => ({
            audio: { data: new Float32Array([0.2, -0.2]), dims: [1, 2] },
        }));
        const session = { outputNames: ['audio'], run };
        class Tensor {
            constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
        }
        const loadDictionary = jest.fn(async () => parseEnglishLexicon(
            'hello HH AH0 L OW1\nworld W ER1 L D'));
        const provider = new OnnxKokoroProvider({
            browserApi: browserApi(), cacheStorage: fakeCache(manifest),
            fetchImpl: jest.fn(), loadDictionary,
            loadSDK: async () => ({
                env: { wasm: {} }, InferenceSession: { create: async () => session }, Tensor,
            }),
        });
        provider.manifest = manifest;
        const output = await provider.synthesize('Hello world.');
        expect(output.samples.length).toBe(2);
        const expected = tokenizePhonemes('həlˈoʊ wˈɚld.');
        expect(Array.from(run.mock.calls[0][0].input_ids.data))
            .toEqual([0n, ...expected.map(BigInt), 0n]);
        await provider.synthesize('Hello world.');
        expect(loadDictionary).toHaveBeenCalledTimes(1);
    });
    test('ONNX default dictionary loader uses local cache and never calls fetch', async () => {
        const manifest = manifestForVariant('onnx', 'q8');
        manifest.assets[0].bytes = 4;
        manifest.assets[1].bytes = 65536;
        const dictionary = dictionaryManifest();
        const storage = fakeCache(manifest);
        const cache = await storage.open();
        const getModel = cache.match;
        cache.match = jest.fn(async key => String(key).includes('/dictionary/')
            ? new Response(['hello HH AH0 L OW1', 'world W ER1 L D', ''].join('\n'), {
                headers: {
                    'x-kokoro-integrity': dictionary.assets[0].integrity,
                    'x-kokoro-bytes': String(dictionary.assets[0].bytes),
                },
            }) : getModel(key));
        const fetcher = jest.fn();
        const session = {
            outputNames: ['audio'],
            run: jest.fn(async () => ({
                audio: { data: new Float32Array([0.2, -0.2]), dims: [1, 2] },
            })),
        };
        class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
        const provider = new OnnxKokoroProvider({
            browserApi: browserApi(), cacheStorage: storage, fetchImpl: fetcher,
            loadSDK: async () => ({
                env: { wasm: {} }, InferenceSession: { create: async () => session }, Tensor,
            }),
        });
        provider.manifest = manifest;
        // The abbreviated fixture covers local inference plumbing; the real
        // SHA-256 behavior has dedicated small-fixture integrity tests.
        const verified = jest.spyOn(ModelDataStore.prototype, 'cachedBytesMatch')
            .mockResolvedValue(true);
        try {
            expect((await provider.synthesize('Hello world.')).samples.length).toBe(2);
        } finally {
            verified.mockRestore();
        }
        expect(fetcher).not.toHaveBeenCalled();
        expect(cache.match).toHaveBeenCalledWith(
            'https://kokoro-model-cache.invalid/model-data/dictionary/' +
            dictionary.revision + '/english/cmudict.dict');
    });
    test('ONNX inference rejects non-finite PCM instead of presenting it as valid speech', async () => {
        const manifest = manifestForVariant('onnx', 'q8');
        manifest.assets[0].bytes = 4;
        manifest.assets[1].bytes = 4096;
        const session = {
            outputNames: ['audio'],
            run: jest.fn(async () => ({
                audio: { data: new Float32Array([NaN, 0.1]), dims: [1, 2] },
            })),
        };
        class Tensor {
            constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
        }
        const sdk = {
            env: { wasm: {} }, InferenceSession: { create: async () => session }, Tensor,
        };
        const provider = new OnnxKokoroProvider({
            browserApi: browserApi(), cacheStorage: fakeCache(manifest),
            fetchImpl: jest.fn(), loadSDK: async () => sdk,
        });
        provider.manifest = manifest;
        await expect(provider.synthesizePhonemes('a b')).rejects.toThrow(/finite/);
        expect(session.run).toHaveBeenCalledTimes(1);
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
