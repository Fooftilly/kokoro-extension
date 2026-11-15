/**
 * Measure HTMLAudioElement start after a full download (muted for autoplay).
 * Restores the caller's mute state so the visible preview stays audible.
 * Not MediaSource / progressive streaming TTFA.
 */
export async function waitServerAudioPlaybackStart(audio) {
    const wasMuted = audio.muted;
    try {
        audio.pause();
        audio.currentTime = 0;
        // Muted play satisfies autoplay policies in packaged dual live.
        audio.muted = true;
        await new Promise((resolve, reject) => {
            const onPlaying = () => { cleanup(); resolve(); };
            const onError = () => {
                cleanup();
                reject(new Error('Server MP3 failed to start playback'));
            };
            const cleanup = () => {
                audio.removeEventListener('playing', onPlaying);
                audio.removeEventListener('error', onError);
            };
            audio.addEventListener('playing', onPlaying, { once: true });
            audio.addEventListener('error', onError, { once: true });
            const playResult = audio.play();
            if (playResult && typeof playResult.then === 'function') {
                playResult.catch(error => {
                    cleanup();
                    reject(error instanceof Error ? error
                        : new Error(String(error?.message || error)));
                });
            }
        });
        audio.pause();
        audio.currentTime = 0;
    } finally {
        audio.muted = wasMuted;
    }
}
