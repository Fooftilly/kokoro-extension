export class AudioManager {
    constructor() {
        this.audioCache = new Map(); // index -> Promise<BlobUrl>
        this.sentences = [];
        this.abortController = new AbortController();
        this.requestQueue = Promise.resolve(); // For sequential processing
    }

    clear() {
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
            this.getAudio(index);
        }
    }

    async fetchAudio(text) {
        const data = await browser.storage.local.get(['pendingVoice', 'pendingApiUrl', 'pendingNormalizationOptions']);

        // Use queue to ensure sequential requests to the API
        // Catching here ensures the chain doesn't break for subsequent requests
        return this.requestQueue = this.requestQueue.catch(() => { }).then(async () => {
            try {
                if (!data.pendingApiUrl) {
                    throw new Error("Missing API URL");
                }
                const endpoint = new URL('audio/speech', data.pendingApiUrl).href;

                const result = await browser.runtime.sendMessage({
                    action: "FETCH_TTS_AUDIO",
                    endpoint: endpoint,
                    payload: {
                        model: 'kokoro',
                        input: text,
                        voice: data.pendingVoice,
                        response_format: 'mp3',
                        speed: 1.0,
                        normalization_options: data.pendingNormalizationOptions
                    }
                });

                if (!result || !result.success) {
                    throw new Error(result?.error || "Background fetch failed");
                }

                return result.dataUrl;
            } catch (e) {
                if (e.name === 'AbortError') throw e;

                let msg = e.message;
                if (msg === "Failed to fetch") {
                    const url = data.pendingApiUrl || "unknown URL";
                    msg = `Connection failed. Is Kokoro-FastAPI running on ${url}?`;
                }
                console.error("Kokoro Fetch failed:", e);
                throw new Error(msg);
            }
        });
    }
}
