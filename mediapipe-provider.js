// Original MediaPipe adapter; only the official locally packaged @mediapipe/tasks-audio
// SDK executes inference. There is no network fallback or model auto-download.
import { manifestForVariant } from './model-catalog.js';
import { ModelDataStore } from './model-data-store.js';

function extensionStore(api, cacheStorage, fetchImpl) {
    return new ModelDataStore({
        origin: api.runtime.getURL('/'), cacheStorage, fetchImpl,
        responseClass: Response, streamClass: TransformStream,
    });
}

export class MediaPipeKokoroProvider {
    constructor({ variant = 'cpu', browserApi = globalThis.browser,
        cacheStorage = globalThis.caches, fetchImpl = globalThis.fetch,
        loadSDK = () => import('./runtimes/mediapipe/audio_bundle.mjs') } = {}) {
        this.manifest = manifestForVariant('mediapipe', variant);
        this.variant = variant;
        this.browserApi = browserApi;
        this.cacheStorage = cacheStorage;
        this.fetchImpl = fetchImpl;
        this.loadSDK = loadSDK;
        this.engine = null;
        this.modelUrl = null;
        this.loading = null;
    }

    get store() {
        return extensionStore(this.browserApi, this.cacheStorage, this.fetchImpl);
    }

    async status() {
        return this.store.status(this.manifest);
    }

    async initialize() {
        if (this.engine) return;
        if (this.loading !== null) return this.loading;
        this.loading = this.loadEngine();
        try {
            await this.loading;
        } finally {
            this.loading = null;
        }
    }

    async loadEngine() {
        const store = this.store;
        if (!(await store.status(this.manifest)).ready) {
            throw new Error('MediaPipe Kokoro model is not installed. Download it explicitly first.');
        }
        const asset = this.manifest.assets[0];
        const cache = await this.cacheStorage.open('kokoro-model-data-v1');
        const response = await cache.match(store.key(this.manifest, asset));
        if (!store.isCurrent(response, asset)) throw new Error('MediaPipe model cache entry is unavailable');
        const model = new Uint8Array(await response.arrayBuffer());
        if (model.byteLength !== asset.bytes) throw new Error('MediaPipe model cache entry length mismatch');

        const sdk = await this.loadSDK();
        if (typeof sdk.FilesetResolver?.forAudioTasks !== 'function' ||
            typeof sdk.TextToSpeech?.createFromOptions !== 'function') {
            throw new Error('Packaged MediaPipe TextToSpeech SDK API unavailable');
        }
        const files = await sdk.FilesetResolver.forAudioTasks(
            this.browserApi.runtime.getURL('runtimes/mediapipe/wasm'));
        // The upstream browser API documents modelAssetPath for .litertlm bundles.
        // Keep this URL alive until close() in case the SDK lazily accesses assets.
        const modelUrl = URL.createObjectURL(new Blob([model], { type: 'application/octet-stream' }));
        try {
            this.engine = await sdk.TextToSpeech.createFromOptions(files, {
                baseOptions: {
                    modelAssetPath: modelUrl,
                    delegate: this.variant === 'gpu' ? 'GPU' : 'CPU',
                },
                defaultVoiceId: 'af_heart', speakingRate: 1,
            });
            this.modelUrl = modelUrl;
        } catch (error) {
            URL.revokeObjectURL(modelUrl);
            throw error;
        }
    }

    async synthesize(text, { voiceId = 'af_heart', speakingRate = 1 } = {}) {
        if (typeof text !== 'string' || !text.trim() || text.length > 20000 ||
            !Number.isFinite(speakingRate) || speakingRate <= 0 || speakingRate > 4 ||
            !/^[a-z]{2}_[a-z]+$/.test(voiceId)) {
            throw new TypeError('Invalid text, speaking rate, or MediaPipe voice');
        }
        await this.initialize();
        const result = await this.engine.synthesize(text, { voiceId, speakingRate });
        if (!(result?.samples instanceof Float32Array) || result.samples.length === 0 ||
            result.sampleRateHz !== 24000) {
            throw new Error('MediaPipe did not return valid Kokoro 24-kHz PCM');
        }
        return { samples: result.samples, sampleRateHz: result.sampleRateHz, voiceId };
    }

    async cancel() {
        if (this.engine && typeof this.engine.cancel === 'function') await this.engine.cancel();
    }

    async close() {
        if (this.engine && typeof this.engine.close === 'function') await this.engine.close();
        this.engine = null;
        if (this.modelUrl) URL.revokeObjectURL(this.modelUrl);
        this.modelUrl = null;
    }
}
