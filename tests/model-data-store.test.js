/**
 * @jest-environment node
 */
import { validateModelManifest, formatModelSize, assessStorageHeadroom, ModelDataStore } from '../model-data-store.js';
import { dictionaryManifest } from '../model-catalog.js';

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
        delete: jest.fn(async key => entries.delete(typeof key === 'string' ? key : key.url)),
        keys: jest.fn(async () => [...entries.keys()].map(url => new Request(url))),
    };
    const cacheStorage = { open: jest.fn(async () => cache) };
    const fetchImpl = jest.fn(async () => new Response(sample, { status: 200 }));
    const lockManager = {
        request: jest.fn(async (name, options, run) => {
            expect(name).toBe('kokoro-model-data-v1');
            if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            return run();
        }),
    };
    const store = new ModelDataStore({
        origin: 'moz-extension://test-uuid/',
        cacheStorage,
        fetchImpl,
        responseClass: Response,
        streamClass: TransformStream,
        lockManager,
    });
    return { cache, cacheStorage, fetchImpl, entries, store, lockManager };
}

describe('opt-in cached model data (#55)', () => {
    test('model storage warning distinguishes an estimated quota shortage from unknown capacity', () => {
        expect(assessStorageHeadroom(80, { quota: 100, usage: 30 })).toEqual({
            requiredBytes: 80, availableBytes: 70, insufficient: true,
        });
        expect(assessStorageHeadroom(50, { quota: 100, usage: 30 })).toEqual({
            requiredBytes: 50, availableBytes: 70, insufficient: false,
        });
        expect(assessStorageHeadroom(0, { quota: 100, usage: 120 })).toEqual({
            requiredBytes: 0, availableBytes: 0, insufficient: false,
        });
        expect(assessStorageHeadroom(25, undefined)).toBeNull();
        expect(assessStorageHeadroom(25, { quota: 100 })).toBeNull();
        expect(assessStorageHeadroom(25, { quota: NaN, usage: 10 })).toBeNull();
        expect(() => assessStorageHeadroom(-1, {})).toThrow(/Invalid model download byte count/);
    });

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
        const wrongRepo = manifest();
        wrongRepo.assets[0].url = wrongRepo.assets[0].url.replace(
            'onnx-community/Kokoro-82M-v1.0-ONNX', 'arbitrary-user/foreign-model');
        expect(() => validateModelManifest(wrongRepo)).toThrow(/pinned official repository/);
        const wrongPath = manifest();
        wrongPath.assets[0].url = wrongPath.assets[0].url.replace(
            'onnx/model_quantized.onnx', 'onnx/other.onnx');
        expect(() => validateModelManifest(wrongPath)).toThrow(/asset path/);
        const queryInjected = manifest();
        queryInjected.assets[0].url += '?filename=model.onnx';
        expect(() => validateModelManifest(queryInjected)).toThrow();
        const executable = manifest();
        executable.assets[0].path = 'remote-executable.wasm';
        executable.assets[0].url = executable.assets[0].url.replace(
            'onnx/model_quantized.onnx', 'remote-executable.wasm');
        expect(() => validateModelManifest(executable)).toThrow(/non-data/);
        const aliases = manifest();
        const alias = { ...aliases.assets[0], path: 'onnx/./model_quantized.onnx' };
        alias.url = alias.url.replace('onnx/model_quantized.onnx', alias.path);
        aliases.assets.push(alias);
        expect(() => validateModelManifest(aliases)).toThrow(/duplicate model asset/);
        const repeatedSlash = manifest();
        repeatedSlash.assets[0].path = 'onnx//model_quantized.onnx';
        repeatedSlash.assets[0].url = repeatedSlash.assets[0].url.replace(
            'onnx/model_quantized.onnx', 'onnx//model_quantized.onnx');
        expect(() => validateModelManifest(repeatedSlash)).toThrow(/duplicate model asset/);
    });

    test('pins the separate dictionary host, commit, checksum and asset path', async () => {
        const entry = dictionaryManifest();
        expect(validateModelManifest(entry)).toBe(3618488);
        for (const url of [
            entry.assets[0].url.replace('raw.githubusercontent.com', 'example.com'),
            entry.assets[0].url.replace('cmusphinx/cmudict', 'attacker/cmudict'),
            entry.assets[0].url + '?trick=1',
            entry.assets[0].url.replace('74790861', '84790861'),
            entry.assets[0].url.replace('cmudict.dict', 'payload.js'),
        ]) {
            const malicious = dictionaryManifest();
            malicious.assets[0].url = url;
            expect(() => validateModelManifest(malicious)).toThrow();
        }
        const { store, fetchImpl } = setup();
        const sampleEntry = dictionaryManifest();
        sampleEntry.assets[0].bytes = 4;
        sampleEntry.assets[0].integrity = integrity;
        expect((await store.status(sampleEntry)).ready).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
        await store.install(sampleEntry);
        expect(fetchImpl).toHaveBeenCalledWith(sampleEntry.assets[0].url,
            expect.objectContaining({ integrity, cache: 'no-store' }));
        expect((await store.status(sampleEntry)).ready).toBe(true);
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

    test('explicit revision cleanup deletes only unreferenced model data and keeps other engines', async () => {
        const { store, entries, cache, fetchImpl } = setup();
        const old = manifest();
        const newer = manifest();
        newer.revision = 'b'.repeat(40);
        newer.assets[0].url = newer.assets[0].url.replace(old.revision, newer.revision);
        const mediapipe = {
            provider: 'mediapipe', revision: old.revision, variant: 'cpu',
            assets: [{
                path: 'models/kokoro.litertlm',
                url: 'https://huggingface.co/litert-community/Kokoro-82M/resolve/' +
                    old.revision + '/models/kokoro.litertlm',
                bytes: sample.byteLength, integrity,
            }],
        };
        await store.install(old);
        await store.install(newer);
        await store.install(mediapipe);
        expect(entries.size).toBe(3);
        expect(await store.removeUnreferenced([newer, mediapipe])).toBe(1);
        expect(entries.size).toBe(2);
        expect((await store.status(newer)).ready).toBe(true);
        expect((await store.status(mediapipe)).ready).toBe(true);
        expect((await store.status(old)).ready).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(cache.keys).toHaveBeenCalledTimes(1);
        await expect(store.removeUnreferenced(null)).rejects.toThrow();
    });

    test('all data mutations take exclusive cross-context locks, but status does not', async () => {
        const { store, lockManager } = setup();
        const m = manifest();
        await store.status(m);
        expect(lockManager.request).not.toHaveBeenCalled();
        await store.install(m);
        await store.remove(m);
        await store.removeUnreferenced([m]);
        expect(lockManager.request).toHaveBeenCalledTimes(3);
        expect(lockManager.request.mock.calls.map(([, options]) => options.mode))
            .toEqual(['exclusive', 'exclusive', 'exclusive']);
    });

    test('rejects incorrect byte count and discards partial cache entries', async () => {
        const { store, fetchImpl, cache } = setup();
        fetchImpl.mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200 }));
        await expect(store.install(manifest())).rejects.toThrow(/length disagrees/);
        expect(cache.delete).toHaveBeenCalled();
        expect((await store.status(manifest())).ready).toBe(false);
    });

    test('cancelling while Cache Storage commits rolls back the completed entry', async () => {
        const { store, cache, entries } = setup();
        const controller = new AbortController();
        const originalPut = cache.put.getMockImplementation();
        cache.put.mockImplementation(async (key, response) => {
            await originalPut(key, response);
            // Cache Storage has committed all bytes, but the user cancelled
            // before the installer received the acknowledgement.
            controller.abort();
        });
        await expect(store.install(manifest(), { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(entries.size).toBe(0);
        expect((await store.status(manifest())).ready).toBe(false);
        expect(cache.delete).toHaveBeenCalledTimes(2); // initial reset + abort rollback
    });

    test('abort after fetch resolves but before caching never writes model data', async () => {
        const { store, fetchImpl, cache, entries } = setup();
        const controller = new AbortController();
        fetchImpl.mockImplementation(async () => {
            controller.abort();
            return new Response(sample, { status: 200 });
        });
        await expect(store.install(manifest(), { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(cache.put).not.toHaveBeenCalled();
        expect(entries.size).toBe(0);
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
