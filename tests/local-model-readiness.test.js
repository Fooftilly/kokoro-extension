/**
 * Classic-script local readiness helpers for toolbar status (#208).
 */
if (typeof global.Response === 'undefined') {
    global.Response = class Response {};
}
if (typeof global.TransformStream === 'undefined') {
    global.TransformStream = class TransformStream {};
}

const readiness = require('../local-model-readiness.js');
const {
    dictionaryManifest,
    listOnnxVoiceAssets,
    manifestForOnnxVoiceAsset,
    manifestForVariant,
} = require('../model-catalog.js');
const ToolbarStatus = require('../toolbar-status.js');

describe('local-model-readiness', () => {
    test('metadataStatus reports ready when integrity headers match', async () => {
        const manifest = manifestForVariant('mediapipe', 'cpu');
        const asset = manifest.assets[0];
        const key = readiness.cacheKey(manifest, asset);
        const cache = {
            match: jest.fn(async (requestKey) => {
                if (requestKey !== key) return undefined;
                return {
                    headers: {
                        get(name) {
                            if (name === 'x-kokoro-integrity') return asset.integrity;
                            if (name === 'x-kokoro-bytes') return String(asset.bytes);
                            return null;
                        },
                    },
                };
            }),
        };
        const cacheStorage = { open: jest.fn(async () => cache) };
        const result = await readiness.metadataStatus(manifest, cacheStorage);
        expect(result.ready).toBe(true);
        expect(result.storedBytes).toBe(asset.bytes);
    });

    test('metadataStatus is not ready when cache miss', async () => {
        const manifest = manifestForVariant('onnx', 'q8');
        const cache = { match: jest.fn(async () => undefined) };
        const cacheStorage = { open: jest.fn(async () => cache) };
        const result = await readiness.metadataStatus(manifest, cacheStorage);
        expect(result.ready).toBe(false);
        expect(result.storedBytes).toBe(0);
    });

    test('probeLocalBackend MediaPipe ready via ModelDataStore (Jest path)', async () => {
        const revision = manifestForVariant('mediapipe', 'cpu').revision;
        const { ModelDataStore } = require('../model-data-store.js');
        const statusSpy = jest.spyOn(ModelDataStore.prototype, 'status').mockResolvedValue({
            ready: true, storedBytes: 1, totalBytes: 1,
        });
        const status = await readiness.probeLocalBackend(
            'mediapipe',
            { mediaPipeVariant: 'cpu' },
            {
                origin: 'chrome-extension://test/',
                cacheStorage: { open: jest.fn() },
                fetchImpl: jest.fn(),
                responseClass: Response,
                streamClass: TransformStream,
                storageLocal: {
                    get: jest.fn(async (defaults = {}) => ({
                        ...defaults,
                        'mediapipeValidatedRevision:cpu': revision,
                    })),
                },
            },
            { classifyLocalReadiness: ToolbarStatus.classifyLocalReadiness }
        );
        expect(status.kind).toBe(ToolbarStatus.KIND.READY);
        statusSpy.mockRestore();
    });

    test('catalog surface used by lite snapshot stays coherent', () => {
        expect(manifestForVariant('mediapipe', 'cpu').revision).toMatch(/^[a-f0-9]{40}$/);
        expect(manifestForVariant('onnx', 'q8').revision).toMatch(/^[a-f0-9]{40}$/);
        expect(dictionaryManifest().revision).toMatch(/^[a-f0-9]{40}$/);
        const optional = listOnnxVoiceAssets().find((v) => v.voiceVariant);
        expect(optional).toBeTruthy();
        expect(manifestForOnnxVoiceAsset(optional.path).variant).toBe(optional.voiceVariant);
    });

    test('packaged catalog-lite cache keys match ModelDataStore (#208 regression)', async () => {
        const { ModelDataStore } = require('../model-data-store.js');
        const store = new ModelDataStore({
            origin: 'chrome-extension://testid/',
            cacheStorage: { open: jest.fn() },
            fetchImpl: jest.fn(),
            responseClass: Response,
            streamClass: TransformStream,
        });
        // Same shape build.js writes into model-catalog-lite.js for Chrome SW.
        const liteManifests = [
            manifestForVariant('mediapipe', 'cpu'),
            manifestForVariant('onnx', 'q8'),
            dictionaryManifest(),
        ];
        const optional = listOnnxVoiceAssets().find((v) => v.voiceVariant);
        if (optional) liteManifests.push(manifestForOnnxVoiceAsset(optional.path));

        const byKey = new Map();
        for (const manifest of liteManifests) {
            for (const asset of manifest.assets) {
                const classicKey = readiness.cacheKey(manifest, asset);
                expect(classicKey).toBe(store.key(manifest, asset));
                byKey.set(classicKey, asset);
            }
        }

        const cache = {
            match: jest.fn(async (requestKey) => {
                const asset = byKey.get(requestKey);
                if (!asset) return undefined;
                return {
                    headers: {
                        get(name) {
                            if (name === 'x-kokoro-integrity') return asset.integrity;
                            if (name === 'x-kokoro-bytes') return String(asset.bytes);
                            return null;
                        },
                    },
                };
            }),
        };
        const cacheStorage = { open: jest.fn(async () => cache) };
        for (const manifest of liteManifests) {
            const result = await readiness.metadataStatus(manifest, cacheStorage);
            expect(result.ready).toBe(true);
        }
    });
});
