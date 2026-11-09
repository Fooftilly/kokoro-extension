/** @jest-environment node */
import { createHash, webcrypto } from 'node:crypto';
import { manifestForVariant } from '../model-catalog.js';
import { OnnxKokoroProvider } from '../onnx-provider.js';

const modelBytes = new Uint8Array([1, 2, 3, 4]);
const voiceBytes = new Uint8Array([5, 6, 7, 8, 9, 10]);
const sri = bytes => 'sha256-' + createHash('sha256').update(bytes).digest('base64');

function fixture({ model = modelBytes, voice = voiceBytes } = {}) {
    const manifest = manifestForVariant('onnx', 'q8');
    manifest.assets.forEach((asset, index) => {
        const bytes = index === 0 ? modelBytes : voiceBytes;
        asset.bytes = bytes.byteLength;
        asset.integrity = sri(bytes);
    });
    const entries = new Map();
    manifest.assets.forEach((asset, index) => {
        const bytes = index === 0 ? model : voice;
        const key = 'https://kokoro-model-cache.invalid/model-data/' +
            manifest.provider + '/' + manifest.revision + '/' + manifest.variant + '/' + asset.path;
        entries.set(key, new Response(bytes, { headers: {
            'x-kokoro-integrity': asset.integrity,
            'x-kokoro-bytes': String(asset.bytes),
        } }));
    });
    const cache = {
        match: jest.fn(async key => entries.get(key)?.clone()),
        delete: jest.fn(),
    };
    const cacheStorage = { open: jest.fn(async () => cache) };
    const fetchImpl = jest.fn();
    const session = { release: jest.fn(async () => {}) };
    const create = jest.fn(async () => session);
    const loadSDK = jest.fn(async () => ({
        env: { wasm: {} },
        InferenceSession: { create },
    }));
    const provider = new OnnxKokoroProvider({
        browserApi: { runtime: { getURL: path => 'moz-extension://test/' + path } },
        cacheStorage, fetchImpl, loadSDK,
    });
    provider.manifest = manifest;
    return { provider, manifest, cache, fetchImpl, create, loadSDK, session };
}

describe('ONNX cached model and voice integrity before inference (#55)', () => {
    const oldCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    beforeEach(() => {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    });
    afterEach(() => {
        if (oldCrypto) Object.defineProperty(globalThis, 'crypto', oldCrypto);
        else delete globalThis.crypto;
    });

    test('accepts pinned model and voice bytes, builds one session, never accesses network', async () => {
        const { provider, create, fetchImpl, cache } = fixture();
        await provider.initialize();
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0]).toEqual(modelBytes);
        expect(provider.voice).toEqual(voiceBytes);
        expect(cache.match).toHaveBeenCalledTimes(4); // Status + one read per asset.
        expect(fetchImpl).not.toHaveBeenCalled();
        await provider.close();
    });

    test.each([
        ['model', { model: new Uint8Array([1, 2, 3, 5]) }],
        ['voice', { voice: new Uint8Array([5, 6, 7, 8, 9, 11]) }],
    ])('rejects tampered %s with matching metadata before loading SDK', async (_name, content) => {
        const { provider, loadSDK, create, fetchImpl, cache } = fixture(content);
        await expect(provider.initialize()).rejects.toThrow(/failed SHA-256 integrity verification/);
        expect(loadSDK).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(cache.delete).not.toHaveBeenCalled(); // No automatic eviction.
        expect(provider.session).toBeNull();
    });

    test('rejects changed model length before SDK construction or downloads', async () => {
        const { provider, loadSDK, fetchImpl } = fixture({ model: new Uint8Array([1]) });
        await expect(provider.initialize()).rejects.toThrow(/unexpected length/);
        expect(loadSDK).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('missing browser SHA-256 fails closed and does not discard existing data', async () => {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
        const { provider, loadSDK, cache, fetchImpl } = fixture();
        await expect(provider.initialize()).rejects.toThrow(/does not support SHA-256/);
        expect(loadSDK).not.toHaveBeenCalled();
        expect(cache.delete).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('a failed integrity check permits a later clean initialization retry', async () => {
        const { provider, manifest, cache, loadSDK } = fixture({
            model: new Uint8Array([1, 2, 3, 5]),
        });
        await expect(provider.initialize()).rejects.toThrow(/failed SHA-256 integrity verification/);
        const priorMatch = cache.match.getMockImplementation();
        cache.match.mockImplementation(async key => {
            if (key.endsWith('/' + manifest.assets[0].path)) {
                return new Response(modelBytes, { headers: {
                    'x-kokoro-integrity': manifest.assets[0].integrity,
                    'x-kokoro-bytes': String(manifest.assets[0].bytes),
                } });
            }
            return priorMatch(key);
        });
        await provider.initialize();
        expect(loadSDK).toHaveBeenCalledTimes(1);
        await provider.close();
    });
});
