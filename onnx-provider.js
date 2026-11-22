// Original ONNX Runtime Web Kokoro adapter. Only documented model interfaces and
// the official, packaged onnxruntime-web engine are used; no unofficial wrapper.
// Plain English text synthesis uses the existing strict, cached CMUdict frontend.
// Out-of-vocabulary words fail closed; do not silently send text to FastAPI.
import { manifestForVariant } from './model-catalog.js';
import { ModelDataStore } from './model-data-store.js';
import { prepareKokoroOnnxInputs, asOnnxRuntimeFeeds, assertKokoroSpeed } from './onnx-kokoro-inputs.js';
import { tokenizePhonemes } from './phoneme-tokenizer.js';
import { loadCachedEnglishLexicon, phonemizeEnglishChunks } from './english-g2p.js';
import { validateKokoroPcm } from './pcm-wav.js';

const BYTES_PER_STYLE = 256 * Float32Array.BYTES_PER_ELEMENT;
const DEFAULT_ONNX_VOICE_ASSET = 'voices/af.bin';

export class OnnxKokoroProvider {
    constructor({ variant = 'q8', voiceAssetPath = DEFAULT_ONNX_VOICE_ASSET,
        browserApi = globalThis.browser,
        cacheStorage = globalThis.caches, fetchImpl = (...args) => globalThis.fetch(...args),
        loadSDK = () => import('./runtimes/onnx/ort.wasm.bundle.min.mjs'),
        loadDictionary = null } = {}) {
        this.manifest = manifestForVariant('onnx', variant);
        this.variant = variant;
        this.voiceAssetPath = typeof voiceAssetPath === 'string' && voiceAssetPath.trim()
            ? voiceAssetPath.trim() : DEFAULT_ONNX_VOICE_ASSET;
        if (!this.manifest.assets.some(asset => asset.path === this.voiceAssetPath)) {
            throw new RangeError('ONNX voice asset is not in the pinned catalog: ' +
                this.voiceAssetPath);
        }
        this.browserApi = browserApi;
        this.cacheStorage = cacheStorage;
        this.fetchImpl = fetchImpl;
        this.loadSDK = loadSDK;
        this.session = null;
        this.engine = null;
        this.voice = null;
        this.maxPhonemes = null;
        this.loading = null;
        this.dictionary = null;
        this.dictionaryLoading = null;
        this.closing = null;
        this.cancellationGeneration = 0;
        this.loadDictionary = loadDictionary ||
            (() => loadCachedEnglishLexicon(this.browserApi, this.cacheStorage, this.fetchImpl));
    }

    get store() {
        return new ModelDataStore({
            origin: this.browserApi.runtime.getURL('/'),
            cacheStorage: this.cacheStorage, fetchImpl: this.fetchImpl,
            responseClass: Response, streamClass: TransformStream,
        });
    }

    async status() {
        return this.store.status(this.manifest);
    }

    async initialize() {
        // Never install a new session before an in-progress release completes.
        if (this.closing !== null) await this.closing;
        if (this.session) return;
        if (this.loading !== null) return this.loading;
        this.loading = this.loadEngine();
        try {
            await this.loading;
        } finally {
            this.loading = null;
        }
    }

    async loadCachedAsset(store, cache, asset) {
        const response = await cache.match(store.key(this.manifest, asset));
        if (!store.isCurrent(response, asset)) throw new Error('ONNX model asset missing from cache');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== asset.bytes) throw new Error('ONNX asset has unexpected length');
        // Verify the same bytes passed to ONNX, not just the cache headers.
        // Keep model and voice data offline and fail before SDK loading.
        if (!await store.loadedBytesMatch(bytes, asset)) {
            throw new Error('ONNX cached model asset failed SHA-256 integrity verification: ' +
                asset.path + '. Use Verify cached data, then Download to repair it.');
        }
        return bytes;
    }

    async loadEngine() {
        const store = this.store;
        if (!(await store.status(this.manifest)).ready) {
            throw new Error('ONNX Kokoro model and voice not installed; download model assets first.');
        }
        const cache = await this.cacheStorage.open('kokoro-model-data-v1');
        const modelAsset = this.manifest.assets.find(asset => /\.onnx$/i.test(asset.path));
        const voiceAsset = this.manifest.assets.find(asset => asset.path === this.voiceAssetPath);
        if (!modelAsset || !voiceAsset) {
            throw new Error('ONNX catalog is missing the model or selected voice asset');
        }
        const modelBytes = await this.loadCachedAsset(store, cache, modelAsset);
        const voiceBytes = await this.loadCachedAsset(store, cache, voiceAsset);
        if (voiceBytes.byteLength % BYTES_PER_STYLE !== 0) {
            throw new TypeError('ONNX voice binary must contain complete 256-float style vectors');
        }
        const styleCount = voiceBytes.byteLength / BYTES_PER_STYLE;
        // styleForLength indexes by unpadded token count; need styleCount > n.
        this.maxPhonemes = Math.min(510, styleCount - 1);
        if (this.maxPhonemes < 1) {
            throw new RangeError('ONNX voice binary has no usable style vectors');
        }
        const sdk = await this.loadSDK();
        if (!sdk?.env?.wasm || typeof sdk.InferenceSession?.create !== 'function') {
            throw new Error('Official packaged ONNX Runtime Web SDK unavailable');
        }
        sdk.env.wasm.wasmPaths = this.browserApi.runtime.getURL('runtimes/onnx/');
        sdk.env.wasm.numThreads = 1; // Universal Chrome/Firefox baseline; no isolation assumption.
        const session = await sdk.InferenceSession.create(modelBytes, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
        this.engine = sdk;
        this.session = session;
        this.voice = voiceBytes;
    }

    // The official ONNX graph consumes phoneme IDs, not words.
    // Keep this entrypoint for IPA-only model diagnostics.
    async synthesizePhonemes(phonemes, { speed = 1 } = {}) {
        const generation = this.cancellationGeneration;
        assertKokoroSpeed(speed);
        const tokens = tokenizePhonemes(phonemes);
        await this.initialize();
        this.assertNotCancelled(generation);
        const inputs = prepareKokoroOnnxInputs(tokens, this.voice, speed);
        const feeds = asOnnxRuntimeFeeds(this.engine, inputs);
        // Diagnostic hook for cancel-join: fire only once native run is pending.
        this.notifyInferenceStarted();
        const outputs = await this.session.run(feeds);
        this.assertNotCancelled(generation);
        const name = this.session.outputNames[0];
        const audio = outputs[name];
        if (!audio?.data || audio.data.length === 0 ||
            !Array.isArray(audio.dims) || audio.dims.reduce((v, d) => v * d, 1) !== audio.data.length) {
            throw new Error('ONNX graph did not return valid float32 audio');
        }
        // SDK output may belong to another JavaScript realm (notably Firefox).
        // The shared PCM validator checks genuine Float32 views across realms,
        // as well as the sample rate, size, finiteness and silence bounds.
        validateKokoroPcm(audio.data, 24000);
        return { samples: audio.data, sampleRateHz: 24000 };
    }

    async englishLexicon() {
        if (this.dictionary) return this.dictionary;
        if (this.dictionaryLoading) return this.dictionaryLoading;
        this.dictionaryLoading = this.loadDictionary();
        try {
            const lexicon = await this.dictionaryLoading;
            if (!(lexicon instanceof Map) || !lexicon.size) throw new Error('English dictionary missing');
            this.dictionary = lexicon;
            return lexicon;
        } finally {
            this.dictionaryLoading = null;
        }
    }

    // Experimental US English dictionary mode. No invented OOV pronunciations,
    // server fallback, or claim of coverage/quality parity with Kokoro's G2P.
    async synthesize(text, { speed = 1 } = {}) {
        if (typeof text !== 'string' || !text.trim() || text.length > 20000) {
            throw new TypeError('Bounded English text required');
        }
        assertKokoroSpeed(speed);
        const generation = this.cancellationGeneration;
        // Preflight every word before any partial inference. Long supported
        // sentences use bounded graphs rather than truncation or remote speech.
        const dictionary = await this.englishLexicon();
        this.assertNotCancelled(generation);
        // Cap chunks from catalog voice size before loading weights (#179 order).
        const voiceMeta = this.manifest.assets.find(asset => asset.path === this.voiceAssetPath);
        const styleCount = voiceMeta ? voiceMeta.bytes / BYTES_PER_STYLE : 0;
        const maxPhonemes = Math.min(510, Math.max(0, styleCount - 1));
        if (maxPhonemes < 1) {
            throw new RangeError('ONNX voice asset has no usable style vectors');
        }
        const chunks = phonemizeEnglishChunks(text, dictionary, maxPhonemes);
        const audio = [];
        let sampleCount = 0;
        for (const chunk of chunks) {
            this.assertNotCancelled(generation);
            const result = await this.synthesizePhonemes(chunk, { speed });
            this.assertNotCancelled(generation);
            if (chunks.length === 1) return result;
            sampleCount += result.samples.length;
            // Same ten-minute bound as the PCM validator and WAV encoder.
            if (sampleCount > 24000 * 60 * 10) {
                throw new RangeError('ONNX speech exceeds the ten-minute audio limit');
            }
            audio.push(result.samples);
        }
        const samples = new Float32Array(sampleCount);
        let offset = 0;
        for (const chunk of audio) {
            samples.set(chunk, offset);
            offset += chunk.length;
        }
        return { samples, sampleRateHz: 24000 };
    }

    assertNotCancelled(generation) {
        if (generation !== this.cancellationGeneration) {
            throw new DOMException('ONNX speech cancelled', 'AbortError');
        }
    }

    /** Optional diagnostic hook (cancel-join). Must not affect synthesis. */
    notifyInferenceStarted() {
        const hook = this.onInferenceStarted;
        if (typeof hook !== 'function') return;
        try {
            hook();
        } catch (_) {
            // Diagnostic callbacks must never fail synthesis.
        }
    }

    async cancel() {
        this.cancellationGeneration++;
        // ONNX Runtime Web does not expose an AbortSignal for an active
        // InferenceSession.run(). The playback manager invalidates the old
        // generation and waits for the current run to settle before starting
        // another. Fence its PCM and skip all remaining long-text chunks.
        // Do not release the session here while native WASM inference runs.
    }

    async close() {
        if (this.closing !== null) return this.closing;
        const closing = (async () => {
            // Initialization and optional lexicon parsing can finish after
            // teardown was requested. Join both before clearing references.
            await Promise.allSettled([this.loading, this.dictionaryLoading].filter(Boolean));
            const session = this.session;
            this.session = null;
            this.engine = null;
            this.voice = null;
            this.dictionary = null;
            this.dictionaryLoading = null;
            if (session && typeof session.release === 'function') await session.release();
        })();
        this.closing = closing;
        try {
            await closing;
        } finally {
            if (this.closing === closing) this.closing = null;
        }
    }
}
