/**
 * Classic-script local model readiness for the toolbar (#208).
 * Chrome MV3 service workers cannot use dynamic import(); load catalog lite via
 * importScripts / Firefox background.scripts, then call probeLocalBackend().
 * Jest uses require() of the real ES modules so ModelDataStore spies still work.
 */
(function () {
    'use strict';

    const CACHE_NAME = 'kokoro-model-data-v1';
    const CACHE_KEY_ORIGIN = 'https://kokoro-model-cache.invalid/';

    function cacheKey(manifest, asset) {
        return new URL(
            'model-data/' + manifest.provider + '/' + manifest.revision +
            '/' + manifest.variant + '/' + asset.path,
            CACHE_KEY_ORIGIN
        ).href;
    }

    function isCurrent(response, asset) {
        return !!response &&
            response.headers.get('x-kokoro-integrity') === asset.integrity &&
            response.headers.get('x-kokoro-bytes') === String(asset.bytes);
    }

    /** Metadata-only readiness (mirrors ModelDataStore.status; no hash / no fetch). */
    async function metadataStatus(manifest, cacheStorage) {
        const cache = await cacheStorage.open(CACHE_NAME);
        let storedBytes = 0;
        let totalBytes = 0;
        for (const asset of manifest.assets) {
            totalBytes += asset.bytes;
            const existing = await cache.match(cacheKey(manifest, asset));
            if (isCurrent(existing, asset)) storedBytes += asset.bytes;
        }
        return { ready: storedBytes === totalBytes, storedBytes, totalBytes };
    }

    function getCatalogApi() {
        if (typeof require === 'function') {
            return require('./model-catalog.js');
        }
        const lite = globalThis.KokoroModelCatalogLite;
        if (!lite) {
            throw new Error('KokoroModelCatalogLite is not loaded');
        }
        return {
            dictionaryManifest() {
                return structuredClone
                    ? structuredClone(lite.dictionary)
                    : JSON.parse(JSON.stringify(lite.dictionary));
            },
            listOnnxVoiceAssets() {
                return lite.onnxVoices;
            },
            manifestForOnnxVoiceAsset(voicePath) {
                const manifest = lite.onnxVoiceManifests[voicePath];
                if (!manifest) {
                    throw new RangeError(
                        'ONNX voice asset is not an optional catalog download: ' +
                        String(voicePath)
                    );
                }
                return structuredClone
                    ? structuredClone(manifest)
                    : JSON.parse(JSON.stringify(manifest));
            },
            manifestForVariant(provider, variant) {
                const manifest = lite[provider] && lite[provider][variant];
                if (!manifest) {
                    throw new RangeError('Unsupported Kokoro model variant');
                }
                return structuredClone
                    ? structuredClone(manifest)
                    : JSON.parse(JSON.stringify(manifest));
            },
        };
    }

    function createStatusChecker(deps) {
        if (typeof require === 'function') {
            const { ModelDataStore } = require('./model-data-store.js');
            const store = new ModelDataStore(deps);
            return (manifest) => store.status(manifest);
        }
        return (manifest) => metadataStatus(manifest, deps.cacheStorage);
    }

    /**
     * @param {string} backend mediapipe | onnx
     * @param {object} settings sync prefs
     * @param {object} deps { origin, cacheStorage, fetchImpl, responseClass, streamClass, storageLocal }
     * @param {object} helpers { classifyLocalReadiness, normalizeOnnxVoiceAsset, onnxFixedVoice }
     */
    async function probeLocalBackend(backend, settings, deps, helpers) {
        const catalog = getCatalogApi();
        const statusOf = createStatusChecker({
            origin: deps.origin,
            cacheStorage: deps.cacheStorage,
            fetchImpl: deps.fetchImpl,
            responseClass: deps.responseClass,
            streamClass: deps.streamClass,
        });

        if (backend === 'mediapipe') {
            const variant = settings.mediaPipeVariant || 'cpu';
            const manifest = catalog.manifestForVariant('mediapipe', variant);
            const key = 'mediapipeValidatedRevision:' + variant;
            const stored = await deps.storageLocal.get({ [key]: null });
            const modelState = await statusOf(manifest);
            return helpers.classifyLocalReadiness({
                backend,
                validatedRevision: stored[key],
                expectedRevision: manifest.revision,
                modelReady: modelState.ready,
            });
        }

        if (backend === 'onnx') {
            const model = catalog.manifestForVariant('onnx', 'q8');
            const key = 'onnxValidatedRevision:q8';
            const stored = await deps.storageLocal.get({ [key]: null });
            const [modelState, dictionaryState] = await Promise.all([
                statusOf(model),
                statusOf(catalog.dictionaryManifest()),
            ]);
            const selected = helpers.normalizeOnnxVoiceAsset
                ? helpers.normalizeOnnxVoiceAsset(settings.onnxVoiceAsset || '')
                : (helpers.onnxFixedVoice || 'voices/af.bin');
            const voiceEntry = catalog.listOnnxVoiceAssets().find((item) => item.path === selected);
            let optionalVoiceRequired = false;
            let voiceReady;
            if (voiceEntry?.voiceVariant) {
                optionalVoiceRequired = true;
                voiceReady = (await statusOf(
                    catalog.manifestForOnnxVoiceAsset(selected)
                )).ready;
            }
            return helpers.classifyLocalReadiness({
                backend,
                validatedRevision: stored[key],
                expectedRevision: model.revision,
                modelReady: modelState.ready,
                dictionaryReady: dictionaryState.ready,
                optionalVoiceRequired,
                voiceReady,
            });
        }

        return { kind: 'unknown', backend, detail: 'unsupported backend' };
    }

    const api = Object.freeze({
        CACHE_NAME,
        cacheKey,
        isCurrent,
        metadataStatus,
        probeLocalBackend,
    });

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    const root = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this);
    root.KokoroLocalModelReadiness = api;
}());
