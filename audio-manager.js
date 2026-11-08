import './tts-providers.js';
import { MediaPipeKokoroProvider } from './mediapipe-provider.js';
import { pcmToWavBlob } from './pcm-wav.js';

export class AudioManager {
    constructor() {
        this.audioCache = new Map(); // index -> { promise, evicted }
        this.cacheWindow = null; // bounded recent sentences after playback advances
        this.audioPins = new Set(); // independent leases retained until downloads finish
        this.sentences = [];
        this.abortController = new AbortController();
        this.requestQueue = Promise.resolve(); // For sequential processing
        // Unlike remote HTTP requests, local inference cannot safely overlap
        // with another invocation on the same WASM engine after clear().
        this.localInferenceQueue = Promise.resolve();
        this.localProvider = null;
        this.localVariant = null;
        this.objectUrls = new Set();
        this.generation = 0;
    }

    clear() {
        this.generation++;
        for (const entry of this.audioCache.values()) entry.evicted = true;
        this.cacheWindow = null;
        // A browser download may still be reading a blob URL after its page
        // moves to a new document. Keep only leased URLs until downloads end.
        const leasedUrls = new Set([...this.audioPins].map(pin => pin.url).filter(Boolean));
        for (const url of this.objectUrls) {
            if (!leasedUrls.has(url)) URL.revokeObjectURL(url);
        }
        this.objectUrls = new Set([...this.objectUrls].filter(url => leasedUrls.has(url)));
        if (this.localProvider) {
            // Cancellation is best-effort but can still be in flight after the
            // previous synthesize() promise settles. Join both operations before
            // allowing a new session to reuse or replace the WASM provider.
            const provider = this.localProvider;
            const cancellation = Promise.resolve().then(() => provider.cancel()).catch(error => {
                console.warn('Local TTS cancellation failed', error);
            });
            this.localInferenceQueue = Promise.all([
                this.localInferenceQueue.catch(() => {}),
                cancellation,
            ]).then(() => {});
        }
        this.audioCache.clear();
        this.sentences = [];
        if (this.abortController) this.abortController.abort();
        this.abortController = new AbortController();
        this.requestQueue = Promise.resolve();
    }

    setSentences(sentences) {
        this.sentences = sentences;
    }

    // Called only after the new playback source has replaced the old one.
    // Retain two sentences behind for Prev/retry and two ahead for prefetch.
    retainWindow(center, behind = 2, ahead = 2) {
        if (!Number.isInteger(center) || center < 0 || center >= this.sentences.length ||
            !Number.isInteger(behind) || behind < 0 ||
            !Number.isInteger(ahead) || ahead < 0) {
            throw new RangeError('Invalid audio cache window');
        }
        this.cacheWindow = { first: center - behind, last: center + ahead };
        for (const [index, entry] of this.audioCache) {
            if (this.isOutsideWindow(index) && !this.isPinned(index)) {
                this.evictAudio(index, entry);
            }
        }
    }

    isOutsideWindow(index) {
        return this.cacheWindow !== null &&
            (index < this.cacheWindow.first || index > this.cacheWindow.last);
    }

    isPinned(index) {
        return [...this.audioPins].some(pin =>
            pin.index === index && pin.generation === this.generation);
    }

    evictAudio(index, entry) {
        if (this.audioCache.get(index) !== entry) return;
        this.audioCache.delete(index);
        entry.evicted = true;
        // Reclaim an already-resolved URL immediately so memory is bounded
        // after a navigation. A pending entry may still settle later; then
        // revoke only manager-owned blob URLs, never server MP3 Data URLs.
        const revoke = url => {
            if (this.objectUrls.delete(url)) URL.revokeObjectURL(url);
        };
        if (entry.url) revoke(entry.url);
        else void entry.promise.then(revoke, () => {});
    }

    // Save/download leases outlive a reading-session reset. They are independent
    // of the bounded cache, and cannot accidentally pin a reused sentence index.
    pinAudio(index) {
        const pin = {
            index, generation: this.generation,
            url: this.audioCache.get(index)?.url || null,
        };
        this.audioPins.add(pin);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.audioPins.delete(pin);
            if (pin.generation !== this.generation) {
                // clear() deliberately retained this URL while the download ran.
                if (pin.url && ![...this.audioPins].some(other => other.url === pin.url) &&
                    this.objectUrls.delete(pin.url)) {
                    URL.revokeObjectURL(pin.url);
                }
                return;
            }
            const entry = this.audioCache.get(index);
            if (entry && this.isOutsideWindow(index) && !this.isPinned(index)) {
                this.evictAudio(index, entry);
            }
        };
    }

    // Drop obsolete queued syntheses before placing the actively selected
    // sentence on the serialized inference lane. If this sentence already
    // entered the model, reuse that in-flight work instead of running it twice.
    // Keep generated URLs until the player replaces the old audio source.
    prioritizeNavigation(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.sentences.length) {
            throw new RangeError('Invalid requested sentence index');
        }
        for (const [cachedIndex, entry] of this.audioCache) {
            if (entry.pending && !this.isPinned(cachedIndex) &&
                (cachedIndex !== index || (entry.speculative && !entry.executing))) {
                this.evictAudio(cachedIndex, entry);
            }
        }
    }

    async getAudio(index, { speculative = false } = {}) {
        if (!Number.isInteger(index) || index < 0 || index >= this.sentences.length) return null;

        if (this.audioCache.has(index)) {
            return this.audioCache.get(index).promise;
        }

        const generation = this.generation;
        const entry = {
            promise: null, evicted: false, url: null,
            pending: true, speculative, executing: false,
        };
        const promise = this.fetchAudio(this.sentences[index].text, generation, entry);
        entry.promise = promise;
        this.audioCache.set(index, entry);
        void promise.then(url => {
            entry.pending = false;
            entry.url = url;
            for (const pin of this.audioPins) {
                if (pin.index === index && pin.generation === generation) pin.url = url;
            }
        }, () => {});
        // A missing model or transient server error must not poison retries.
        // Do not remove a newer request for the same sentence.
        void promise.catch(() => {
            entry.pending = false;
            if (this.generation === generation && this.audioCache.get(index) === entry) {
                this.audioCache.delete(index);
            }
        });
        return promise;
    }

    prefetch(index) {
        if (Number.isInteger(index) && index >= 0 &&
            index < this.sentences.length && !this.audioCache.has(index)) {
            void this.getAudio(index, { speculative: true }).catch(error => {
                if (error.name !== 'AbortError') console.warn('Kokoro prefetch failed:', error);
            });
        }
    }

    async localAudio(text, data, isStale = () => false, onSynthesisStart = () => {}) {
        // Local PCM synthesis runs only in the extension-owned playback page.
        // A clear() starts a new session, but the previous WASM synthesis may
        // still be running even after cancel() returns. Serialize local jobs
        // across sessions; never concurrently invoke the same engine.
        const generation = this.generation;
        const work = this.localInferenceQueue.catch(() => {}).then(async () => {
            if (generation !== this.generation || isStale()) {
                throw new DOMException('Local generation cancelled', 'AbortError');
            }
            const variant = data.pendingMediaPipeVariant || 'cpu';
            if (!this.localProvider || this.localVariant !== variant) {
                if (this.localProvider) await this.localProvider.close();
                if (generation !== this.generation || isStale()) {
                    throw new DOMException('Local generation cancelled', 'AbortError');
                }
                this.localProvider = new MediaPipeKokoroProvider({ variant });
                this.localVariant = variant;
            }
            let result;
            try {
                // Mark the request only when it actually reaches the official
                // engine, not while waiting behind prior queued work.
                onSynthesisStart();
                result = await this.localProvider.synthesize(text, {
                    voiceId: data.pendingLocalVoice || 'af_heart',
                });
            } catch (error) {
                // A best-effort cancel() may make the SDK throw its own error.
                // The caller requested cancellation; never misreport the stale
                // session as a fresh inference failure or synthesize a fallback.
                if (generation !== this.generation || isStale()) {
                    throw new DOMException('Local generation cancelled', 'AbortError');
                }
                throw error;
            }
            if (generation !== this.generation || isStale()) {
                throw new DOMException('Local generation cancelled', 'AbortError');
            }
            const url = URL.createObjectURL(pcmToWavBlob(result.samples, result.sampleRateHz));
            this.objectUrls.add(url);
            return url;
        });
        // A rejected or cancelled previous generation cannot poison the lane.
        this.localInferenceQueue = work.catch(() => {});
        return work;
    }

    async remoteAudio(text, data, onRequestStart = () => {}) {
        if (!data.pendingApiUrl) throw new Error('Missing API URL');
        const endpoint = new URL('audio/speech', data.pendingApiUrl).href;
        // A server prefetch that already reached the background request is
        // useful if its sentence becomes active. Avoid issuing it twice.
        onRequestStart();
        const result = await browser.runtime.sendMessage({
            action: 'FETCH_TTS_AUDIO',
            backend: 'fastapi',
            endpoint,
            payload: {
                model: 'kokoro',
                input: text,
                voice: data.pendingVoice,
                response_format: 'mp3',
                speed: 1.0,
                normalization_options: data.pendingNormalizationOptions,
            },
        });
        if (!result || !result.success) {
            throw new Error(result?.error || 'Background fetch failed');
        }
        return result.dataUrl;
    }

    async routeAudio(text, data, isStale = () => false, onSynthesisStart = () => {}) {
        // Resolve through the same strict IDs as the background dispatcher.
        // An unknown explicit value must NEVER be interpreted as FastAPI.
        const backend = globalThis.KokoroTtsProviders.resolveBackend(data.pendingTtsBackend);
        if (backend === globalThis.KokoroTtsProviders.MEDIAPIPE) {
            return this.localAudio(text, data, isStale, onSynthesisStart);
        }
        if (backend === globalThis.KokoroTtsProviders.FASTAPI) {
            return this.remoteAudio(text, data, onSynthesisStart);
        }
        throw new Error('Local TTS backend ONNX plain-text synthesis is not yet available. No text was sent to Kokoro-FastAPI.');
    }

    async fetchAudio(text, generation = this.generation, entry = null) {
        const isStale = () => generation !== this.generation || entry?.evicted === true;
        const data = await browser.storage.local.get([
            'pendingVoice', 'pendingApiUrl', 'pendingNormalizationOptions',
            'pendingTtsBackend', 'pendingMediaPipeVariant', 'pendingLocalVoice',
        ]);
        if (isStale()) {
            throw new DOMException('Audio request cancelled', 'AbortError');
        }
        // Preserve serialized generation and recover the queue after earlier errors.
        // Recheck inside the queue: clear() may run while this request is waiting
        // behind another synthesis, or while remote synthesis is in progress.
        this.requestQueue = this.requestQueue.catch(() => {}).then(async () => {
            if (isStale()) {
                throw new DOMException('Audio request cancelled', 'AbortError');
            }
            try {
                const audio = await this.routeAudio(text, data, isStale, () => {
                    if (entry) entry.executing = true;
                });
                if (isStale()) {
                    if (this.objectUrls.delete(audio)) URL.revokeObjectURL(audio);
                    throw new DOMException('Audio request cancelled', 'AbortError');
                }
                return audio;
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                let message = error.message;
                if (message === 'Failed to fetch') {
                    message = `Connection failed. Is Kokoro-FastAPI running on ${data.pendingApiUrl || 'unknown URL'}?`;
                }
                console.error('Kokoro Fetch failed:', error);
                throw new Error(message);
            }
        });
        return this.requestQueue;
    }
}
