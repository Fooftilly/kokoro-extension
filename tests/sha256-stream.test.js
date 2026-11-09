/** @jest-environment node */
import { createHash, randomBytes } from 'node:crypto';
import { IncrementalSha256, blobMatchesSha256 } from '../sha256-stream.js';
import { MediaPipeKokoroProvider } from '../mediapipe-provider.js';
import { manifestForVariant } from '../model-catalog.js';

const digest = bytes => 'sha256-' + createHash('sha256').update(bytes).digest('base64');
const modelBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
function mediaFixture(data = modelBytes) {
    const manifest = manifestForVariant('mediapipe', 'cpu');
    manifest.assets[0].bytes = modelBytes.byteLength;
    manifest.assets[0].integrity = digest(modelBytes);
    const asset = manifest.assets[0];
    const blob = new Blob([data]);
    const response = {
        headers: new Headers({
            'x-kokoro-integrity': asset.integrity,
            'x-kokoro-bytes': String(asset.bytes),
        }),
        blob: jest.fn(async () => blob),
        arrayBuffer: jest.fn(() => { throw new Error('Unwanted full buffer copy'); }),
    };
    const cache = { match: jest.fn(async () => response), delete: jest.fn() };
    const cacheStorage = { open: jest.fn(async () => cache) };
    const fetchImpl = jest.fn();
    const engine = {
        synthesize: jest.fn(async () => ({
            samples: new Float32Array([0.2, -0.1]), sampleRateHz: 24000,
        })),
        close: jest.fn(async () => {}),
    };
    const createFromOptions = jest.fn(async () => engine);
    const loadSDK = jest.fn(async () => ({
        FilesetResolver: { forAudioTasks: async () => ({}) },
        TextToSpeech: { createFromOptions },
    }));
    const provider = new MediaPipeKokoroProvider({
        browserApi: { runtime: { getURL: path => 'moz-extension://test/' + path } },
        cacheStorage, fetchImpl, loadSDK,
    });
    provider.manifest = manifest;
    return { provider, loadSDK, createFromOptions, response, cache, fetchImpl, engine };
}

describe('bounded-memory SHA-256 from locally cached MediaPipe Blob', () => {
    test('matches fixed SHA-256 known-answer vectors including padding boundaries', () => {
        const vectors = [
            ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
            ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        ];
        for (const [text, hash] of vectors) {
            const value = new IncrementalSha256();
            value.update(Buffer.from(text));
            expect(Buffer.from(value.digest()).toString('hex')).toBe(hash);
            expect(() => value.update(new Uint8Array(1))).toThrow();
            expect(() => value.digest()).toThrow();
        }
    });

    test('agrees with independent Node SHA-256 across irregular chunks and large input', () => {
        for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 10000, 2 * 1024 * 1024]) {
            const data = randomBytes(length);
            const state = new IncrementalSha256();
            for (let pos = 0; pos < data.length; pos += 73) {
                state.update(data.subarray(pos, pos + 73));
            }
            expect(Buffer.from(state.digest()).toString('hex'))
                .toBe(createHash('sha256').update(data).digest('hex'));
        }
    });

    test('hashes Blob streams rather than allocating a full extra ArrayBuffer', async () => {
        const data = randomBytes(128 * 1024);
        const blob = new Blob([data]);
        blob.arrayBuffer = jest.fn(() => { throw Error('full duplicate allocation'); });
        expect(await blobMatchesSha256(blob, {
            bytes: data.length, integrity: digest(data),
        })).toBe(true);
        expect(blob.arrayBuffer).not.toHaveBeenCalled();
        expect(await blobMatchesSha256(blob, {
            bytes: data.length, integrity: digest(new Uint8Array(data.length)),
        })).toBe(false);
        expect(await blobMatchesSha256(blob, {
            bytes: data.length - 1, integrity: digest(data),
        })).toBe(false);
    });

    test('stream verification respects abort before and during the streamed hash', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const controller = new AbortController();
        controller.abort();
        await expect(blobMatchesSha256(new Blob([bytes]), {
            bytes: 4, integrity: digest(bytes),
        }, controller.signal)).rejects.toHaveProperty('name', 'AbortError');
        const during = new AbortController();
        const partiallyRead = {
            size: 4,
            stream: () => new ReadableStream({
                pull(stream) {
                    stream.enqueue(bytes.subarray(0, 2));
                    during.abort();
                },
            }),
        };
        await expect(blobMatchesSha256(partiallyRead, {
            bytes: 4, integrity: digest(bytes),
        }, during.signal)).rejects.toHaveProperty('name', 'AbortError');
    });

    test('valid cached model loads normally without any fetch or extra ArrayBuffer', async () => {
        const { provider, fetchImpl, loadSDK, createFromOptions, response, engine } = mediaFixture();
        await provider.initialize();
        expect(loadSDK).toHaveBeenCalledTimes(1);
        expect(createFromOptions).toHaveBeenCalledTimes(1);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(response.arrayBuffer).not.toHaveBeenCalled();
        await provider.close();
        expect(engine.close).toHaveBeenCalledTimes(1);
    });

    test('same-length corrupted model fails closed before loading the official SDK', async () => {
        const { provider, fetchImpl, loadSDK, cache, response } =
            mediaFixture(new Uint8Array([1, 2, 3, 4, 5, 6, 8]));
        await expect(provider.initialize()).rejects.toThrow(/failed SHA-256 integrity verification/);
        expect(loadSDK).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(cache.delete).not.toHaveBeenCalled();
        expect(response.arrayBuffer).not.toHaveBeenCalled();
        expect(provider.engine).toBeNull();
    });

    test('truncated model fails before SDK loading or automatic repair', async () => {
        const { provider, fetchImpl, loadSDK, cache } =
            mediaFixture(new Uint8Array([1, 2, 3]));
        await expect(provider.initialize()).rejects.toThrow(/length mismatch/);
        expect(loadSDK).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(cache.delete).not.toHaveBeenCalled();
    });

    test('integrity failure permits retry after user repairs the cached asset', async () => {
        const { provider, cache, loadSDK } = mediaFixture(new Uint8Array([1, 2, 3, 4, 5, 6, 8]));
        await expect(provider.initialize()).rejects.toThrow(/failed SHA-256 integrity/);
        const fixed = mediaFixture();
        cache.match.mockImplementation(fixed.cache.match.getMockImplementation());
        await provider.initialize();
        expect(loadSDK).toHaveBeenCalledTimes(1);
        await provider.close();
    });
});
