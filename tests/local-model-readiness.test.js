/**
 * Classic-script local readiness helpers for toolbar status (#208).
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const os = require('os');

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

function loadCatalogViaBabel() {
    const file = path.join(__dirname, '../model-catalog.js');
    const { code } = babel.transformFileSync(file, {
        presets: [['@babel/preset-env', { modules: 'commonjs' }]],
        babelrc: false,
        configFile: false,
    });
    const mod = new Module(file);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod._compile(code, file);
    return mod.exports;
}

function writeCatalogLiteLikeBuild(destPath) {
    const catalog = loadCatalogViaBabel();
    const onnxVoices = catalog.listOnnxVoiceAssets();
    const onnxVoiceManifests = {};
    for (const voice of onnxVoices) {
        if (voice.voiceVariant) {
            onnxVoiceManifests[voice.path] = catalog.manifestForOnnxVoiceAsset(voice.path);
        }
    }
    const lite = {
        mediapipe: {
            cpu: catalog.manifestForVariant('mediapipe', 'cpu'),
            gpu: catalog.manifestForVariant('mediapipe', 'gpu'),
        },
        onnx: { q8: catalog.manifestForVariant('onnx', 'q8') },
        dictionary: catalog.dictionaryManifest(),
        onnxVoices,
        onnxVoiceManifests,
    };
    fs.writeFileSync(destPath, [
        '(function (root) {',
        "'use strict';",
        'var KokoroModelCatalogLite = ' + JSON.stringify(lite) + ';',
        'root.KokoroModelCatalogLite = KokoroModelCatalogLite;',
        "if (typeof module !== 'undefined' && module.exports) module.exports = KokoroModelCatalogLite;",
        '}(typeof globalThis !== "undefined" ? globalThis : this));',
        '',
    ].join('\n'));
}

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

    test('generated model-catalog-lite.js loads for packaged SW path (#208)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-catalog-lite-'));
        const dest = path.join(dir, 'model-catalog-lite.js');
        writeCatalogLiteLikeBuild(dest);
        delete globalThis.KokoroModelCatalogLite;
        const lite = require(dest);
        expect(lite.mediapipe.cpu.revision)
            .toBe(manifestForVariant('mediapipe', 'cpu').revision);
        expect(lite.onnx.q8.revision).toBe(manifestForVariant('onnx', 'q8').revision);
        expect(globalThis.KokoroModelCatalogLite.dictionary.revision)
            .toBe(dictionaryManifest().revision);
        fs.rmSync(dir, { recursive: true, force: true });
        delete globalThis.KokoroModelCatalogLite;
    });
});
