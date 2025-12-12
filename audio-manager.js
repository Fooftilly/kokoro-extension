export class AudioManager {
    constructor() {
        this.audioCache = new Map(); // index -> Promise<BlobUrl>
        this.sentences = [];
        this.abortController = new AbortController();
    }

    clear() {
        this.audioCache.clear();
        this.sentences = [];
        if (this.abortController) this.abortController.abort();
        this.abortController = new AbortController();
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
        const data = await browser.storage.local.get(['pendingVoice', 'pendingApiUrl']);
        try {
            if (!data.pendingApiUrl) {
                throw new Error("Missing API URL");
            }
            const endpoint = new URL('audio/speech', data.pendingApiUrl).href;

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'kokoro',
                    input: text,
                    voice: data.pendingVoice,
                    response_format: 'mp3',
                    speed: 1.0 // Generate at 1x, client handles speed
                }),
                signal: this.abortController.signal
            });

            if (!response.ok) throw new Error("API Error");

            const blob = await response.blob();
            return URL.createObjectURL(blob);
        } catch (e) {
            if (e.name === 'AbortError') throw e;

            let msg = e.message;
            if (msg === "Failed to fetch") {
                msg = "Connection failed. Is Kokoro-FastAPI running on 127.0.0.1:8880?";
            }
            console.error("Kokoro Fetch failed:", e);
            // We'll let the caller handle UI status updates
            throw new Error(msg);
        }
    }
}
