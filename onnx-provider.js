// Original ONNX Runtime Web Kokoro adapter. Only documented model interfaces and
// the official, packaged onnxruntime-web engine are used; no unofficial wrapper.
// Plain text synthesis remains unavailable until a reviewed G2P frontend exists.
import { manifestForVariant } from './model-catalog.js';
import { ModelDataStore } from './model-data-store.js';
import { prepareKokoroOnnxInputs, asOnnxRuntimeFeeds } from './onnx-kokoro-inputs.js';
import { tokenizePhonemes } from './phoneme-tokenizer.js';
import { loadBundledEnglishLexicon, phonemizeEnglish } from './english-g2p.js';
import { validateKokoroPcm } from './pcm-wav.js';

export class OnnxKokoroProvider {
    constructor({ variant = 'q8', browserApi = globalThis.browser,
        cacheStorage = globalThis.caches, fetchImpl = globalThis.fetch,
        loadSDK = () => import('./runtimes/onnx/ort.wasm.bundle.min.mjs'),
        loadDictionary = null } = {}) {
        this.manifest = manifestForVariant('onnx', variant);
        this.variant = variant;
        this.browserApi = browserApi;
        this.cacheStorage = cacheStorage;
        this.fetchImpl = fetchImpl;
        this.loadSDK = loadSDK;
        this.session = null;
        this.engine = null;
        this.voice = null;
        this.loading = null;
        this.dictionary = null;
        this.dictionaryLoading = null;
        this.loadDictionary = loadDictionary ||
            (() => loadBundledEnglishLexicon(this.browserApi, this.fetchImpl));
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
        if (this.session) return;
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
            throw new Error('ONNX Kokoro model and voice not installed; download model assets first.');
        }
        const cache = await this.cacheStorage.open('kokoro-model-data-v1');
        const assets = [];
        for (const asset of this.manifest.assets) {
            const response = await cache.match(store.key(this.manifest, asset));
            if (!store.isCurrent(response, asset)) throw new Error('ONNX model asset missing from cache');
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength !== asset.bytes) throw new Error('ONNX asset has unexpected length');
            assets.push(bytes);
        }
        const sdk = await this.loadSDK();
        if (!sdk?.env?.wasm || typeof sdk.InferenceSession?.create !== 'function') {
            throw new Error('Official packaged ONNX Runtime Web SDK unavailable');
        }
        sdk.env.wasm.wasmPaths = this.browserApi.runtime.getURL('runtimes/onnx/');
        sdk.env.wasm.numThreads = 1; // Universal Chrome/Firefox baseline; no isolation assumption.
        const session = await sdk.InferenceSession.create(assets[0], {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
        this.engine = sdk;
        this.session = session;
        this.voice = assets[1];
    }

    // The official ONNX graph consumes phoneme IDs, not words.
    // Keep this entrypoint for IPA-only model diagnostics.
    async synthesizePhonemes(phonemes, { speed = 1 } = {}) {
        const tokens = tokenizePhonemes(phonemes);
        await this.initialize();
        const inputs = prepareKokoroOnnxInputs(tokens, this.voice, speed);
        const feeds = asOnnxRuntimeFeeds(this.engine, inputs);
        const outputs = await this.session.run(feeds);
        const name = this.session.outputNames[0];
        const audio = outputs[name];
        if (!(audio?.data instanceof Float32Array) || audio.data.length === 0 ||
            !Array.isArray(audio.dims) || audio.dims.reduce((v, d) => v * d, 1) !== audio.data.length) {
            throw new Error('ONNX graph did not return valid float32 audio');
        }
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
        await this.initialize();
        const dictionary = await this.englishLexicon();
        return this.synthesizePhonemes(phonemizeEnglish(text, dictionary), { speed });
    }

    async close() {
        if (this.session && typeof this.session.release === 'function') await this.session.release();
        this.session = null;
        this.engine = null;
        this.voice = null;
        this.dictionary = null;
    }
}
