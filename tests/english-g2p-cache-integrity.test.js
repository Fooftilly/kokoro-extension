/** @jest-environment node */
import { webcrypto } from 'node:crypto';
import { loadCachedEnglishLexicon } from '../english-g2p.js';
import { dictionaryManifest } from '../model-catalog.js';

// A tiny original fixture whose digest matches its own pinned manifest.
// The real 3.6-MB CMUdict is never checked into the repository or CI.
jest.mock('../model-catalog.js', () => {
    const contents = 'hello HH AH0 L OW1\nworld W ER1 L D\n';
    const revision = 'a'.repeat(40);
    return {
        dictionaryManifest: () => ({
            provider: 'dictionary', variant: 'english', revision,
            assets: [{
                path: 'cmudict.dict', bytes: Buffer.byteLength(contents),
                integrity: 'sha256-' + require('node:crypto').createHash('sha256')
                    .update(contents).digest('base64'),
                url: 'https://raw.githubusercontent.com/cmusphinx/cmudict/' +
                    revision + '/cmudict.dict',
            }],
        }),
    };
});

const good = 'hello HH AH0 L OW1\nworld W ER1 L D\n';
function extensionApi() {
    return { runtime: { getURL: path => 'moz-extension://test/' + path } };
}
function cacheFor(contents) {
    const asset = dictionaryManifest().assets[0];
    const fetchImpl = jest.fn();
    const match = jest.fn(async () => new Response(contents, {
        headers: {
            'x-kokoro-integrity': asset.integrity,
            'x-kokoro-bytes': String(asset.bytes),
        },
    }));
    const cacheStorage = { open: jest.fn(async () => ({ match })) };
    return { cacheStorage, fetchImpl, match };
}

describe('ONNX English dictionary byte integrity on offline inference', () => {
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    beforeEach(() => {
        Object.defineProperty(globalThis, 'crypto', {
            configurable: true, value: webcrypto,
        });
    });
    afterEach(() => {
        if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
        else delete globalThis.crypto;
    });

    test('parses the dictionary only after real SHA-256 matches without any network access', async () => {
        const { cacheStorage, fetchImpl, match } = cacheFor(good);
        const words = await loadCachedEnglishLexicon(extensionApi(), cacheStorage, fetchImpl);
        expect(words.get('hello')).toBe('HH AH0 L OW1');
        expect(words.get('world')).toBe('W ER1 L D');
        expect(match).toHaveBeenCalledTimes(2); // Metadata status and verified read.
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('rejects changed bytes even when size and integrity headers remain intact', async () => {
        const modified = good.replace('world', 'worlx'); // Same byte length.
        const { cacheStorage, fetchImpl } = cacheFor(modified);
        await expect(loadCachedEnglishLexicon(extensionApi(), cacheStorage, fetchImpl))
            .rejects.toThrow(/failed SHA-256 integrity verification/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('rejects truncated dictionary data without silently parsing partial pronunciations', async () => {
        const { cacheStorage, fetchImpl } = cacheFor(good.slice(0, -2));
        await expect(loadCachedEnglishLexicon(extensionApi(), cacheStorage, fetchImpl))
            .rejects.toThrow(/failed SHA-256 integrity verification/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('SHA-256 service failures do not trigger deletion or background repair', async () => {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
        const { cacheStorage, fetchImpl, match } = cacheFor(good);
        await expect(loadCachedEnglishLexicon(extensionApi(), cacheStorage, fetchImpl))
            .rejects.toThrow(/does not support SHA-256 cache verification/);
        expect(match).toHaveBeenCalledTimes(2);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(cacheStorage.open).toHaveBeenCalled();
    });
});
