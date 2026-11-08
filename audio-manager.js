import { MediaPipeKokoroProvider } from './mediapipe-provider.js';
import { pcmToWavBlob } from './pcm-wav.js';

export class AudioManager {
    constructor() {
        this.audioCache = new Map(); // index -> { promise, evicted }
        this.cacheWindow = null; // bounded recent sentences after playback advances
        this.audioPins = new Map(); // downloads keep their source URL valid until finished
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
        this.audioPins.clear();
        for (const url of this.objectUrls) URL.revokeObjectURL(url);
        this.objectUrls.clear();
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
            if (this.isOutsideWindow(index) && !this.audioPins.has(index)) {
                this.evictAudio(index, entry);
            }
        }
    }

    isOutsideWindow(index) {
        return this.cacheWindow !== null &&
            (index < this.cacheWindow.first || index > this.cacheWindow.last);
    }

    evictAudio(index, entry) {
        if (this.audioCache.get(index) !== entry) return;
        this.audioCache.delete(index);
        entry.evicted = true;
        // Pending synthesis may still settle; revoke only URLs that *this*
        // manager created, never remote MP3 Data URLs or a replacement entry.
        void entry.promise.then(url => {
            if (this.objectUrls.delete(url)) URL.revokeObjectURL(url);
        }, () => {});
    }

    // Hold the exact sentence's generated URL while its download is pending.
    // The release callback is idempotent and cannot alter a newer session.
    pinAudio(index) {
        const generation = this.generation;
        this.audioPins.set(index, (this.audioPins.get(index) || 0) + 1);
        let released = false;
        return () => {
            if (released || generation !== this.generation) return;
            released = true;
            const remaining = (this.audioPins.get(index) || 1) - 1;
            if (remaining > 0) this.audioPins.set(index, remaining);
            else {
                this.audioPins.delete(index);
                const entry = this.audioCache.get(index);
                if (entry && this.isOutsideWindow(index)) this.evictAudio(index, entry);
            }
        };
    }

    async getAudio(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.sentences.length) return null;

        if (this.audioCache.has(index)) {
            return this.audioCache.get(index).promise;
        }

        const generation = this.generation;
        const entry = { promise: null, evicted: false };
        const promise = this.fetchAudio(this.sentences[index].text, generation, entry);
        entry.promise = promise;
        this.audioCache.set(index, entry);
        // A missing model or transient server error must not poison retries.
        // Do not remove a newer request for the same sentence.
        void promise.catch(() => {
            if (this.generation === generation && this.audioCache.get(index) === entry) {
                this.audioCache.delete(index);
            }
        });
        return promise;
    }

    prefetch(index) {
        if (index < this.sentences.length && !this.audioCache.has(index)) {
            void this.getAudio(index).catch(error => {
                if (error.name !== 'AbortError') console.warn('Kokoro prefetch failed:', error);
            });
        }
    }

    async localAudio(text, data, isStale = () => false) {
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
                if (generation !== this.generation) {
                    throw new DOMException('Local generation cancelled', 'AbortError');
                }
                this.localProvider = new MediaPipeKokoroProvider({ variant });
                this.localVariant = variant;
            }
            let result;
            try {
                result = await this.localProvider.synthesize(text, {
                    voiceId: data.pendingLocalVoice || 'af_heart',
                });
            } catch (error) {
                // A best-effort cancel() may make the SDK throw its own error.
                // The caller requested cancellation; never misreport the stale
                // session as a fresh inference failure or synthesize a fallback.
                if (generation !== this.generation) {
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

    async remoteAudio(text, data) {
        if (!data.pendingApiUrl) throw new Error('Missing API URL');
        const endpoint = new URL('audio/speech', data.pendingApiUrl).href;
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

    async routeAudio(text, data, isStale = () => false) {
        const backend = data.pendingTtsBackend === undefined ? 'fastapi' : data.pendingTtsBackend;
        if (backend === 'mediapipe') return this.localAudio(text, data, isStale);
        if (backend === 'fastapi') return this.remoteAudio(text, data);
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
                const audio = await this.routeAudio(text, data, isStale);
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
