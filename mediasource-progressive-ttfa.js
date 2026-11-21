/**
 * Progressive MediaSource TTFA measurement for streamed FastAPI MP3.
 * Appends response body chunks to a SourceBuffer as they arrive and times
 * fetch-start → first `playing` event. Never invents a TTFA number: when
 * MediaSource / mime support is missing, returns unavailable instead.
 *
 * Concurrent deadline: playback, stream failure, and timeout settle the
 * measurement — never wait forever for EOF after playing/timeout/error.
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
 * Fail-closed unavailable result (never invents ttfaMs).
 * @param {object} [partial]
 */
export function progressiveTtfaUnavailable(partial = {}) {
    return {
        measured: false,
        unavailable: true,
        usedMediaSource: partial.usedMediaSource === true,
        ttfaMs: null,
        mimeType: partial.mimeType ?? null,
        reason: String(partial.reason || 'Progressive MediaSource TTFA unavailable'),
    };
}

function measuredResult(ttfaMs, mimeType) {
    return {
        measured: true,
        unavailable: false,
        usedMediaSource: true,
        ttfaMs,
        mimeType,
        reason: null,
    };
}

/** Best-effort cancel of an unused fetch body (unsupported / early exit). */
export function cancelReadableStreamBody(body) {
    if (!body) return;
    try {
        if (typeof body.cancel === 'function') {
            void body.cancel();
            return;
        }
    } catch { /* ignore */ }
    try {
        const reader = typeof body.getReader === 'function'
            ? body.getReader() : null;
        if (reader && typeof reader.cancel === 'function') {
            void reader.cancel();
        }
    } catch { /* ignore */ }
}

function waitMediaSourceOpen(mediaSource, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('Progressive MediaSource aborted before sourceopen'));
            return;
        }
        const timer = timeoutMs > 0
            ? setTimeout(() => reject(new Error(
                'MediaSource sourceopen timed out')), timeoutMs)
            : null;
        const onAbort = () => {
            if (timer != null) clearTimeout(timer);
            reject(new Error('Progressive MediaSource aborted before sourceopen'));
        };
        mediaSource.addEventListener('sourceopen', () => {
            if (timer != null) clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }, { once: true });
        mediaSource.addEventListener('error', () => {
            if (timer != null) clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            reject(new Error('MediaSource failed before sourceopen'));
        }, { once: true });
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

function createAppendQueue(mediaSource, sourceBuffer, state) {
    let appendChain = Promise.resolve();
    const maybeEndOfStream = () => {
        if (state.endOfStreamCalled || !state.streamDone || !sourceBuffer ||
            sourceBuffer.updating || mediaSource.readyState !== 'open') {
            return;
        }
        state.endOfStreamCalled = true;
        try {
            mediaSource.endOfStream();
        } catch (error) {
            void error;
        }
    };
    const queueAppend = (chunk) => {
        if (state.aborted) return Promise.resolve();
        appendChain = appendChain.then(() => new Promise((resolve, reject) => {
            if (state.aborted || !sourceBuffer ||
                mediaSource.readyState !== 'open') {
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
    return { queueAppend, maybeEndOfStream, getAppendChain: () => appendChain };
}

/**
 * Wait for muted progressive `playing`. Returns promise + detach so callers
 * can clear listeners/timeouts on every early unavailable path (PR Lens).
 * @returns {{ promise: Promise<number>, detach: () => void }}
 */
function waitPlayingTtfa(audio, startedAt, signal) {
    let detach = () => {};
    const promise = new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('Progressive MediaSource aborted before playing'));
            return;
        }
        let settled = false;
        const onPlaying = () => {
            cleanupListeners();
            if (settled) return;
            settled = true;
            resolve(performance.now() - startedAt);
        };
        const onError = () => {
            cleanupListeners();
            if (settled) return;
            settled = true;
            reject(new Error('Progressive MediaSource audio element error'));
        };
        const onAbort = () => {
            cleanupListeners();
            if (settled) return;
            settled = true;
            reject(new Error('Progressive MediaSource aborted before playing'));
        };
        const cleanupListeners = () => {
            audio.removeEventListener('playing', onPlaying);
            audio.removeEventListener('error', onError);
            signal?.removeEventListener?.('abort', onAbort);
        };
        detach = () => {
            cleanupListeners();
            if (settled) return;
            settled = true;
            // Detach without rejecting — caller already settled via finish().
        };
        audio.addEventListener('playing', onPlaying, { once: true });
        audio.addEventListener('error', onError, { once: true });
        signal?.addEventListener?.('abort', onAbort, { once: true });
        const playResult = audio.play();
        if (typeof playResult?.then === 'function') {
            playResult.catch((error) => {
                cleanupListeners();
                if (settled) return;
                settled = true;
                reject(error instanceof Error ? error
                    : new Error(String(error?.message || error)));
            });
        }
    });
    // No-op catch so early finish()/detach cannot leave an unhandled rejection
    // if the caller abandons the promise after cleanup.
    promise.catch(() => {});
    return { promise, detach: () => detach() };
}

async function pumpBodyToSourceBuffer(body, queueAppend, state) {
    const reader = body.getReader();
    state.reader = reader;
    let firstChunkAppended = false;
    try {
        while (!state.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            if (state.aborted) break;
            if (!value || value.byteLength === 0) continue;
            const copy = value instanceof Uint8Array
                ? value.slice()
                : new Uint8Array(value);
            await queueAppend(copy);
            firstChunkAppended = true;
        }
    } finally {
        try {
            if (!state.aborted) await reader.cancel();
        } catch { /* ignore */ }
        state.reader = null;
    }
    return firstChunkAppended;
}

/**
 * Measure progressive MediaSource TTFA from an already-open fetch Response
 * body stream. Caller owns request start time via `startedAt`.
 *
 * Settles on first of: playing (measured), timeout/error/abort (unavailable).
 * Never blocks forever waiting for EOF after settle.
 *
 * @param {object} options
 * @param {ReadableStream} options.body
 * @param {number} [options.startedAt]
 * @param {string} [options.contentType]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
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
        cancelReadableStreamBody(options.body);
        return progressiveTtfaUnavailable({ reason: probe.reason });
    }
    const body = options.body;
    if (!body || typeof body.getReader !== 'function') {
        return progressiveTtfaUnavailable({
            mimeType: probe.mimeType,
            reason: 'Response body stream unavailable for progressive MSE',
        });
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

    const state = {
        streamDone: false,
        endOfStreamCalled: false,
        aborted: false,
        reader: null,
        detachPlaying: null,
        deadlineTimer: null,
    };
    const abortController = new AbortController();
    const onOuterAbort = () => abortController.abort();
    if (options.signal) {
        if (options.signal.aborted) abortController.abort();
        else options.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const signal = abortController.signal;

    const cleanup = () => {
        state.aborted = true;
        if (state.deadlineTimer != null) {
            clearTimeout(state.deadlineTimer);
            state.deadlineTimer = null;
        }
        try { state.detachPlaying?.(); } catch { /* ignore */ }
        state.detachPlaying = null;
        try { abortController.abort(); } catch { /* ignore */ }
        try { state.reader?.cancel(); } catch { /* ignore */ }
        state.reader = null;
        try { audio.pause(); } catch { /* ignore */ }
        try {
            if (audio.src) audio.removeAttribute('src');
            audio.load();
        } catch { /* ignore */ }
        try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
        cancelReadableStreamBody(body);
        options.signal?.removeEventListener?.('abort', onOuterAbort);
    };

    let settled = false;
    let settleResolve;
    const settledPromise = new Promise((resolve) => { settleResolve = resolve; });
    // finish() always clears deadline + playing listeners before return
    // (PR Lens: no pending playingPromise timeout/listeners on unavailable).
    const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        settleResolve(result);
    };

    state.deadlineTimer = timeoutMs > 0
        ? setTimeout(() => {
            finish(progressiveTtfaUnavailable({
                usedMediaSource: true,
                mimeType,
                reason: 'Progressive MediaSource TTFA timed out after ' +
                    timeoutMs + 'ms',
            }));
        }, timeoutMs)
        : null;

    try {
        await waitMediaSourceOpen(mediaSource, timeoutMs, signal);
        if (settled) return settledPromise;

        let sourceBuffer;
        try {
            sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        } catch (error) {
            finish(progressiveTtfaUnavailable({
                usedMediaSource: true,
                mimeType,
                reason: 'addSourceBuffer failed: ' +
                    String(error?.message || error),
            }));
            return settledPromise;
        }

        const { queueAppend, maybeEndOfStream, getAppendChain } =
            createAppendQueue(mediaSource, sourceBuffer, state);

        // Observe playing concurrently with the stream pump.
        const playing = waitPlayingTtfa(audio, startedAt, signal);
        state.detachPlaying = playing.detach;
        playing.promise.then((ttfaMs) => {
            if (!(Number.isFinite(ttfaMs) && ttfaMs >= 0)) {
                finish(progressiveTtfaUnavailable({
                    usedMediaSource: true,
                    mimeType,
                    reason: 'Progressive MediaSource TTFA was not a finite ms value',
                }));
                return;
            }
            finish(measuredResult(ttfaMs, mimeType));
        }).catch((error) => {
            if (settled) return;
            finish(progressiveTtfaUnavailable({
                usedMediaSource: true,
                mimeType,
                reason: error?.message || error,
            }));
        });

        // Pump stream; EOS before playing lets short clips still start.
        // Early reader/queueAppend throws finish() via catch — detachPlaying
        // + deadline cleared inside finish/cleanup (no unhandled rejection).
        void (async () => {
            try {
                const firstChunkAppended = await pumpBodyToSourceBuffer(
                    body, queueAppend, state);
                if (settled || state.aborted) return;
                state.streamDone = true;
                maybeEndOfStream();
                await getAppendChain();
                if (settled || state.aborted) return;
                if (!firstChunkAppended) {
                    finish(progressiveTtfaUnavailable({
                        usedMediaSource: true,
                        mimeType,
                        reason: 'Stream completed without MediaSource appendable bytes',
                    }));
                }
                // Else: wait for playing / deadline (already racing).
            } catch (error) {
                if (settled) return;
                finish(progressiveTtfaUnavailable({
                    usedMediaSource: true,
                    mimeType,
                    reason: error?.message || error,
                }));
            }
        })();

        return settledPromise;
    } catch (error) {
        finish(progressiveTtfaUnavailable({
            usedMediaSource: true,
            mimeType,
            reason: error?.message || error,
        }));
        return settledPromise;
    }
}
