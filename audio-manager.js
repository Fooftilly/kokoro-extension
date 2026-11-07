import { MediaPipeKokoroProvider } from './mediapipe-provider.js';
import { pcmToWavBlob } from './pcm-wav.js';

export class AudioManager {
    constructor() {
        this.audioCache = new Map(); // index -> Promise<BlobUrl>
        this.sentences = [];
        this.abortController = new AbortController();
        this.requestQueue = Promise.resolve(); // For sequential processing
        this.localProvider = null;
        this.localVariant = null;
        this.objectUrls = new Set();
        this.generation = 0;
    }

    clear() {
        this.generation++;
        for (const url of this.objectUrls) URL.revokeObjectURL(url);
        this.objectUrls.clear();
        if (this.localProvider) {
            void this.localProvider.cancel().catch(error => console.warn('Local TTS cancellation failed', error));
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

    async getAudio(index) {
        if (index >= this.sentences.length) return null;

        if (this.audioCache.has(index)) {
            return this.audioCache.get(index);
        }

        const generation = this.generation;
        const promise = this.fetchAudio(this.sentences[index].text, generation);
        this.audioCache.set(index, promise);
        // A missing model or a transient server error must not permanently
        // poison this sentence's cache. Do not delete a newer generation's entry.
        void promise.catch(() => {
            if (this.generation === generation && this.audioCache.get(index) === promise) {
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

    async localAudio(text, data) {
        // Local PCM synthesis runs in the extension-owned playback page.
        // Never call runtime.sendMessage or a remote endpoint from this path.
        const variant = data.pendingMediaPipeVariant || 'cpu';
        if (!this.localProvider || this.localVariant !== variant) {
            if (this.localProvider) await this.localProvider.close();
            this.localProvider = new MediaPipeKokoroProvider({ variant });
            this.localVariant = variant;
        }
        const generation = this.generation;
        const result = await this.localProvider.synthesize(text, {
            voiceId: data.pendingLocalVoice || 'af_heart',
        });
        if (generation !== this.generation) {
            throw new DOMException('Local generation cancelled', 'AbortError');
        }
        const url = URL.createObjectURL(pcmToWavBlob(result.samples, result.sampleRateHz));
        this.objectUrls.add(url);
        return url;
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

    async routeAudio(text, data) {
        const backend = data.pendingTtsBackend === undefined ? 'fastapi' : data.pendingTtsBackend;
        if (backend === 'mediapipe') return this.localAudio(text, data);
        if (backend === 'fastapi') return this.remoteAudio(text, data);
        throw new Error('Local TTS backend ONNX plain-text synthesis is not yet available. No text was sent to Kokoro-FastAPI.');
    }

    async fetchAudio(text, generation = this.generation) {
        const data = await browser.storage.local.get([
            'pendingVoice', 'pendingApiUrl', 'pendingNormalizationOptions',
            'pendingTtsBackend', 'pendingMediaPipeVariant', 'pendingLocalVoice',
        ]);
        if (generation !== this.generation) {
            throw new DOMException('Audio request cancelled', 'AbortError');
        }
        // Preserve serialized generation and recover the queue after earlier errors.
        // Recheck inside the queue: clear() may run while this request is waiting
        // behind another synthesis, or while remote synthesis is in progress.
        this.requestQueue = this.requestQueue.catch(() => {}).then(async () => {
            if (generation !== this.generation) {
                throw new DOMException('Audio request cancelled', 'AbortError');
            }
            try {
                const audio = await this.routeAudio(text, data);
                if (generation !== this.generation) {
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
