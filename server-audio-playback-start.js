/**
 * Measure HTMLAudioElement start after a full download (muted for autoplay).
 * Restores the caller's mute state so the visible preview stays audible.
 * Not MediaSource / progressive streaming TTFA.
 */

/** Default bound so a stalled play() cannot hang the Model Manager Test CTA. */
export const DEFAULT_SERVER_PLAYBACK_START_TIMEOUT_MS = 10000;

/**
 * @param {HTMLAudioElement} audio
 * @param {{ timeoutMs?: number }} [options]
 */
export async function waitServerAudioPlaybackStart(audio, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
        ? options.timeoutMs
        : DEFAULT_SERVER_PLAYBACK_START_TIMEOUT_MS;
    const wasMuted = audio.muted;
    try {
        audio.pause();
        audio.currentTime = 0;
        // Muted play satisfies autoplay policies in packaged dual live.
        audio.muted = true;
        await new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(value);
            };
            const onPlaying = () => { finish(resolve); };
            const onError = () => {
                finish(reject, new Error('Server MP3 failed to start playback'));
            };
            const cleanup = () => {
                if (timer != null) {
                    clearTimeout(timer);
                    timer = null;
                }
                audio.removeEventListener('playing', onPlaying);
                audio.removeEventListener('error', onError);
            };
            audio.addEventListener('playing', onPlaying, { once: true });
            audio.addEventListener('error', onError, { once: true });
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    finish(reject, new Error(
                        'Server MP3 playback start timed out after ' +
                        timeoutMs + 'ms'));
                }, timeoutMs);
            }
            const playResult = audio.play();
            // Avoid Promise-in-boolean (Sonar S7735); thenable check is enough.
            if (typeof playResult?.then === 'function') {
                playResult.catch(error => {
                    finish(reject, error instanceof Error ? error
                        : new Error(String(error?.message || error)));
                });
            }
        });
    } finally {
        try {
            audio.pause();
            audio.currentTime = 0;
        } catch {
            // Ignore pause/seek failures on broken media elements.
        }
        audio.muted = wasMuted;
    }
}
