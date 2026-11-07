/**
 * @jest-environment node
 */
import { validateModelManifest, formatModelSize, ModelDataStore } from '../model-data-store.js';

const sha = 'a'.repeat(40);
const integrity = 'sha256-' + Buffer.alloc(32).toString('base64');
const sample = new Uint8Array([1, 2, 3, 4]);

function manifest() {
    return {
        provider: 'onnx',
        revision: sha,
        variant: 'q8',
        assets: [{
            path: 'onnx/model_quantized.onnx',
            url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/' +
                sha + '/onnx/model_quantized.onnx',
            bytes: sample.byteLength,
            integrity,
        }],
    };
}

function setup() {
    const entries = new Map();
    const cache = {
        match: jest.fn(async key => entries.get(key)),
        put: jest.fn(async (key, response) => {
            const data = await response.arrayBuffer();
            entries.set(key, new Response(data, { headers: response.headers }));
        }),
        delete: jest.fn(async key => entries.delete(key)),
    };
    const cacheStorage = { open: jest.fn(async () => cache) };
    const fetchImpl = jest.fn(async () => new Response(sample, { status: 200 }));
    const store = new ModelDataStore({
        origin: 'moz-extension://test-uuid/',
        cacheStorage,
        fetchImpl,
        responseClass: Response,
        streamClass: TransformStream,
    });
    return { cache, cacheStorage, fetchImpl, entries, store };
}

describe('opt-in cached model data (#55)', () => {
    test('sizes are computed from complete pinned manifest, not estimated model size', () => {
        expect(validateModelManifest(manifest())).toBe(4);
        expect(formatModelSize(92000000)).toBe('92.0 MB');
        expect(() => formatModelSize(-1)).toThrow();
        const unsafe = manifest();
        unsafe.assets[0].url = 'http://example.com/unpinned.onnx';
        expect(() => validateModelManifest(unsafe)).toThrow();
        const duplicate = manifest();
        duplicate.assets.push({ ...duplicate.assets[0] });
        expect(() => validateModelManifest(duplicate)).toThrow();
        const missingHash = manifest();
        missingHash.assets[0].integrity = '';
        expect(() => validateModelManifest(missingHash)).toThrow();
    });

    test('downloads only when explicitly installed, verifies response size and reuses cached result', async () => {
        const { store, fetchImpl, cacheStorage } = setup();
        const data = manifest();
        const key = store.key(data, data.assets[0]);
        expect(new URL(key).protocol).toBe('https:');
        expect(new URL(key).hostname).toBe('kokoro-model-cache.invalid');
        expect((await store.status(data)).ready).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
        const progress = jest.fn();
        const result = await store.install(data, { onProgress: progress });
        expect(result).toEqual({ ready: true, storedBytes: 4, totalBytes: 4 });
        expect(fetchImpl).toHaveBeenCalledWith(data.assets[0].url,
            expect.objectContaining({ integrity, cache: 'no-store' }));
        expect(progress).toHaveBeenCalledWith({ completedBytes: 4, totalBytes: 4 });
        expect((await store.status(data)).ready).toBe(true);
        await store.install(data);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(cacheStorage.open).toHaveBeenCalled();
        await store.remove(data);
        expect((await store.status(data)).ready).toBe(false);
    });

    test('rejects incorrect byte count and discards partial cache entries', async () => {
        const { store, fetchImpl, cache } = setup();
        fetchImpl.mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200 }));
        await expect(store.install(manifest())).rejects.toThrow(/length disagrees/);
        expect(cache.delete).toHaveBeenCalled();
        expect((await store.status(manifest())).ready).toBe(false);
    });

    test('rejects aborted downloads without a fetch', async () => {
        const { store, fetchImpl } = setup();
        const controller = new AbortController();
        controller.abort();
        await expect(store.install(manifest(), { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('requires an extension-origin store and an allowlisted provider', () => {
        expect(() => new ModelDataStore({
            origin: 'https://example.org/', cacheStorage: { open() {} },
            fetchImpl: () => {}, responseClass: Response, streamClass: TransformStream,
        })).toThrow(/extension origin/);
        const bad = manifest();
        bad.provider = 'fastapi';
        expect(() => validateModelManifest(bad)).toThrow();
    });
});
