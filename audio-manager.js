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

        const promise = this.fetchAudio(this.sentences[index].text);
        this.audioCache.set(index, promise);
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

    async fetchAudio(text) {
        const data = await browser.storage.local.get([
            'pendingVoice', 'pendingApiUrl', 'pendingNormalizationOptions',
            'pendingTtsBackend', 'pendingMediaPipeVariant', 'pendingLocalVoice',
        ]);
        // Preserve serialized generation and recover the queue after earlier errors.
        this.requestQueue = this.requestQueue.catch(() => {}).then(async () => {
            try {
                return await this.routeAudio(text, data);
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
