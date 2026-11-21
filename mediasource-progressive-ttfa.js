/**
 * Progressive MediaSource TTFA measurement for streamed FastAPI MP3.
 * Appends response body chunks to a SourceBuffer as they arrive and times
 * fetch-start → first `playing` event. Never invents a TTFA number: when
 * MediaSource / mime support is missing, returns unavailable instead.
 */

export const DEFAULT_PROGRESSIVE_TTFA_TIMEOUT_MS = 15000;

/** Primary MSE mime candidates for Kokoro-FastAPI MP3 streams. */
export const PROGRESSIVE_MP3_MIME_CANDIDATES = Object.freeze([
    'audio/mpeg',
    'audio/mpeg; codecs="mp3"',
]);

/**
 * @returns {{ supported: boolean, mimeType: string|null, reason: string|null }}
 */
export function probeMediaSourceProgressiveMp3Support() {
    if (typeof MediaSource === 'undefined' ||
        typeof MediaSource.isTypeSupported !== 'function') {
        return {
            supported: false,
            mimeType: null,
            reason: 'MediaSource API unavailable',
        };
    }
    for (const mimeType of PROGRESSIVE_MP3_MIME_CANDIDATES) {
        if (MediaSource.isTypeSupported(mimeType)) {
            return { supported: true, mimeType, reason: null };
        }
    }
    return {
        supported: false,
        mimeType: null,
        reason: 'MediaSource does not support progressive audio/mpeg',
    };
}

/**
 * Measure progressive MediaSource TTFA from an already-open fetch Response
 * body stream. Caller owns request start time via `startedAt`.
 *
 * @param {object} options
 * @param {ReadableStream} options.body
 * @param {number} [options.startedAt]
 * @param {string} [options.contentType]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{
 *   measured: boolean,
 *   unavailable: boolean,
 *   usedMediaSource: boolean,
 *   ttfaMs: number|null,
 *   mimeType: string|null,
 *   reason: string|null
 * }>}
 */
export async function measureProgressiveMediaSourceTtfa(options = {}) {
    const probe = probeMediaSourceProgressiveMp3Support();
    if (!probe.supported) {
        return {
            measured: false,
            unavailable: true,
            usedMediaSource: false,
            ttfaMs: null,
            mimeType: null,
            reason: probe.reason,
        };
    }
    const body = options.body;
    if (!body || typeof body.getReader !== 'function') {
        return {
            measured: false,
            unavailable: true,
            usedMediaSource: false,
            ttfaMs: null,
            mimeType: probe.mimeType,
            reason: 'Response body stream unavailable for progressive MSE',
        };
    }

    const startedAt = Number.isFinite(options.startedAt)
        ? options.startedAt
        : performance.now();
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
        ? options.timeoutMs
        : DEFAULT_PROGRESSIVE_TTFA_TIMEOUT_MS;
    const mimeType = probe.mimeType;
    const mediaSource = new MediaSource();
    const audio = document.createElement('audio');
    audio.muted = true;
    audio.preload = 'auto';
    const objectUrl = URL.createObjectURL(mediaSource);
    audio.src = objectUrl;

    let settled = false;
    let sourceBuffer = null;
    let appendChain = Promise.resolve();
    let streamDone = false;
    let endOfStreamCalled = false;

    const cleanup = () => {
        try { audio.pause(); } catch { /* ignore */ }
        try {
            if (audio.src) audio.removeAttribute('src');
            audio.load();
        } catch { /* ignore */ }
        try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
    };

    const finishUnavailable = (reason) => {
        if (settled) return null;
        settled = true;
        cleanup();
        return {
            measured: false,
            unavailable: true,
            usedMediaSource: true,
            ttfaMs: null,
            mimeType,
            reason: String(reason || 'Progressive MediaSource TTFA unavailable'),
        };
    };

    try {
        await new Promise((resolve, reject) => {
            const timer = timeoutMs > 0
                ? setTimeout(() => reject(new Error(
                    'MediaSource sourceopen timed out')), timeoutMs)
                : null;
            mediaSource.addEventListener('sourceopen', () => {
                if (timer != null) clearTimeout(timer);
                resolve();
            }, { once: true });
            mediaSource.addEventListener('error', () => {
                if (timer != null) clearTimeout(timer);
                reject(new Error('MediaSource failed before sourceopen'));
            }, { once: true });
        });

        try {
            sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        } catch (error) {
            const result = finishUnavailable(
                'addSourceBuffer failed: ' + String(error?.message || error));
            return result;
        }

        const maybeEndOfStream = () => {
            if (endOfStreamCalled || !streamDone || !sourceBuffer ||
                sourceBuffer.updating || mediaSource.readyState !== 'open') {
                return;
            }
            endOfStreamCalled = true;
            try {
                mediaSource.endOfStream();
            } catch (error) {
                // Ignore EOS races after error paths.
                void error;
            }
        };

        const queueAppend = (chunk) => {
            appendChain = appendChain.then(() => new Promise((resolve, reject) => {
                if (!sourceBuffer || mediaSource.readyState !== 'open') {
                    resolve();
                    return;
                }
                const onUpdate = () => {
                    sourceBuffer.removeEventListener('updateend', onUpdate);
                    sourceBuffer.removeEventListener('error', onError);
                    maybeEndOfStream();
                    resolve();
                };
                const onError = () => {
                    sourceBuffer.removeEventListener('updateend', onUpdate);
                    sourceBuffer.removeEventListener('error', onError);
                    reject(new Error('SourceBuffer append failed'));
                };
                sourceBuffer.addEventListener('updateend', onUpdate, { once: true });
                sourceBuffer.addEventListener('error', onError, { once: true });
                try {
                    sourceBuffer.appendBuffer(chunk);
                } catch (error) {
                    sourceBuffer.removeEventListener('updateend', onUpdate);
                    sourceBuffer.removeEventListener('error', onError);
                    reject(error instanceof Error ? error
                        : new Error(String(error?.message || error)));
                }
            }));
            return appendChain;
        };

        const playingPromise = new Promise((resolve, reject) => {
            let timer = null;
            const onPlaying = () => {
                if (timer != null) clearTimeout(timer);
                cleanupListeners();
                resolve(performance.now() - startedAt);
            };
            const onError = () => {
                if (timer != null) clearTimeout(timer);
                cleanupListeners();
                reject(new Error('Progressive MediaSource audio element error'));
            };
            const cleanupListeners = () => {
                audio.removeEventListener('playing', onPlaying);
                audio.removeEventListener('error', onError);
            };
            audio.addEventListener('playing', onPlaying, { once: true });
            audio.addEventListener('error', onError, { once: true });
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    cleanupListeners();
                    reject(new Error(
                        'Progressive MediaSource TTFA timed out after ' +
                        timeoutMs + 'ms'));
                }, timeoutMs);
            }
            const playResult = audio.play();
            if (typeof playResult?.then === 'function') {
                playResult.catch((error) => {
                    cleanupListeners();
                    if (timer != null) clearTimeout(timer);
                    reject(error instanceof Error ? error
                        : new Error(String(error?.message || error)));
                });
            }
        });

        const reader = body.getReader();
        let firstChunkAppended = false;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            const copy = value instanceof Uint8Array
                ? value.slice()
                : new Uint8Array(value);
            await queueAppend(copy);
            firstChunkAppended = true;
        }
        streamDone = true;
        maybeEndOfStream();
        await appendChain;

        if (!firstChunkAppended) {
            const result = finishUnavailable(
                'Stream completed without MediaSource appendable bytes');
            return result;
        }

        const ttfaMs = await playingPromise;
        if (settled) {
            return {
                measured: false,
                unavailable: true,
                usedMediaSource: true,
                ttfaMs: null,
                mimeType,
                reason: 'Progressive MediaSource TTFA settled early',
            };
        }
        settled = true;
        cleanup();
        if (!(Number.isFinite(ttfaMs) && ttfaMs >= 0)) {
            return {
                measured: false,
                unavailable: true,
                usedMediaSource: true,
                ttfaMs: null,
                mimeType,
                reason: 'Progressive MediaSource TTFA was not a finite ms value',
            };
        }
        return {
            measured: true,
            unavailable: false,
            usedMediaSource: true,
            ttfaMs,
            mimeType,
            reason: null,
        };
    } catch (error) {
        const result = finishUnavailable(error?.message || error);
        if (result) return result;
        return {
            measured: false,
            unavailable: true,
            usedMediaSource: true,
            ttfaMs: null,
            mimeType,
            reason: String(error?.message || error),
        };
    }
}
