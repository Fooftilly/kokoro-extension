/**
 * Progressive MediaSource TTFA measurement for streamed FastAPI MP3.
 * Appends response body chunks to a SourceBuffer as they arrive and times
 * fetch-start → first `playing` event. Never invents a TTFA number: when
 * MediaSource / mime support is missing, returns unavailable instead.
 *
 * Concurrent deadline: playback, stream failure, and timeout settle the
 * measurement — never wait forever for EOF after playing/timeout/error.
 * Measured only when `playing` fires before stream EOF (post-EOF = unavailable).
 */

export const DEFAULT_PROGRESSIVE_TTFA_TIMEOUT_MS = 15000;

/** Cap HTTP error diagnostics kept in progressive unavailable reasons. */
export const PROGRESSIVE_HTTP_ERROR_BODY_LIMIT = 512;

/** Swallow rejected cancel() promises (locked-body TypeError must not escape). */
function swallowCancel(result) {
    if (result && typeof result.then === 'function') {
        void result.catch(() => {});
    }
}

function cancelReaderQuietly(reader) {
    if (!reader || typeof reader.cancel !== 'function') return;
    try {
        swallowCancel(reader.cancel());
    } catch { /* ignore */ }
}

function releaseReaderLockQuietly(reader) {
    if (!reader || typeof reader.releaseLock !== 'function') return;
    try {
        reader.releaseLock();
    } catch { /* ignore */ }
}

/**
 * Stream up to `max` decoded characters, then cancel — never wait for EOF.
 * @param {ReadableStream} body
 * @param {number} max
 * @param {AbortSignal} [signal]
 */
async function readStreamPreview(body, max, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    const onAbort = () => cancelReaderQuietly(reader);
    if (signal) {
        if (signal.aborted) cancelReaderQuietly(reader);
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        while (out.length < max) {
            if (signal?.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            out += decoder.decode(value || new Uint8Array(), { stream: true });
            if (out.length > max) out = out.slice(0, max);
        }
    } catch {
        /* ignore stream errors — status-only reason is fine */
    } finally {
        signal?.removeEventListener?.('abort', onAbort);
        cancelReaderQuietly(reader);
        releaseReaderLockQuietly(reader);
    }
    return out;
}

/** Last-resort full text() when no ReadableStream body is available. */
async function readFallbackResponseText(response, max) {
    if (typeof response.text !== 'function') return '';
    try {
        const text = await response.text();
        if (typeof text !== 'string' || !text) return '';
        return text.length > max ? text.slice(0, max) : text;
    } catch {
        return '';
    }
}

/**
 * Read a bounded response body for diagnostics without waiting for EOF.
 * Prefers a streamed reader so a long/open error body cannot stall the
 * FastAPI card; cancels once the preview cap is reached.
 * @param {Response} response
 * @param {number} [limit]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function readBoundedResponseText(
    response,
    limit = PROGRESSIVE_HTTP_ERROR_BODY_LIMIT,
    signal = undefined,
) {
    if (!response) return '';
    const max = Number.isFinite(limit) && limit >= 0
        ? limit
        : PROGRESSIVE_HTTP_ERROR_BODY_LIMIT;
    if (max === 0 || signal?.aborted) return '';
    const body = response.body;
    if (body && typeof body.getReader === 'function') {
        return readStreamPreview(body, max, signal);
    }
    return readFallbackResponseText(response, max);
}

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
        playedBeforeEof: partial.playedBeforeEof === true,
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
        playedBeforeEof: true,
    };
}

/**
 * Cancel an unlocked fetch body (before a reader is acquired).
 * Never call this while a reader still owns the lock.
 */
export function cancelReadableStreamBody(body) {
    if (!body || typeof body.cancel !== 'function') return;
    try {
        swallowCancel(body.cancel());
    } catch { /* ignore */ }
}

function releaseReader(reader) {
    if (!reader) return;
    cancelReaderQuietly(reader);
    releaseReaderLockQuietly(reader);
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
 * can clear listeners on every early unavailable path.
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
    promise.catch(() => {});
    return { promise, detach: () => detach() };
}

/**
 * Pump body → SourceBuffer. Releases reader lock in finally (cancel only if
 * not normal EOF). Settlement is independent of cancel completion.
 *
 * bodyClosed flips only when read() returns done (queue fully drained). Do not
 * use reader.closed for the playing gate: UA streams fulfill closed when the
 * last chunk is dequeued — before that chunk's append finishes — which would
 * mark short one-chunk FastAPI responses as post-download incorrectly.
 */
async function pumpBodyToSourceBuffer(body, queueAppend, state) {
    const reader = body.getReader();
    state.reader = reader;
    state.readerAcquired = true;
    // Fulfill ignored for EOF gate (pump drain owns bodyClosed). Rejection
    // while measuring → unavailable (stream error mid-append). Cancel after
    // abort/settle is ignored via state.aborted / reachedEof.
    if (reader?.closed && typeof reader.closed.then === 'function') {
        reader.closed.then(() => {}, (error) => {
            if (state.aborted || state.reachedEof) return;
            try { state.onStreamError?.(error); } catch { /* ignore */ }
        });
    }
    let firstChunkAppended = false;
    let reachedEof = false;
    try {
        while (!state.aborted) {
            const { done, value } = await reader.read();
            if (done) {
                reachedEof = true;
                // Fully drained — including any chunks that were queued when
                // the producer closed. Distinct from pending updateend.
                state.bodyClosed = true;
                break;
            }
            if (state.aborted) break;
            if (!value || value.byteLength === 0) continue;
            const copy = value instanceof Uint8Array
                ? value.slice()
                : new Uint8Array(value);
            // Playing during this append still counts as progressive: the
            // chunk was read while the body had unread/in-flight data.
            await queueAppend(copy);
            firstChunkAppended = true;
        }
    } finally {
        // Release lock always. Cancel only when aborted/incomplete — not after
        // normal EOF (cancelling a locked body from cleanup would race).
        try {
            if (!reachedEof) swallowCancel(reader.cancel());
        } catch { /* ignore */ }
        try {
            if (typeof reader.releaseLock === 'function') reader.releaseLock();
        } catch { /* ignore */ }
        state.reader = null;
        state.reachedEof = reachedEof;
    }
    return firstChunkAppended;
}

/**
 * Measure progressive MediaSource TTFA from an already-open fetch Response
 * body stream. Caller owns request start time via `startedAt`.
 *
 * Settles on first of: playing-before-EOF (measured), timeout/error/abort /
 * playing-after-EOF (unavailable). Never blocks forever waiting for EOF.
 *
 * @param {object} options
 * @param {ReadableStream} options.body
 * @param {number} [options.startedAt]
 * @param {string} [options.contentType]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
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
        // True when pump has drained the body (read done). Not reader.closed
        // (that fires when the last chunk is dequeued, before its append).
        bodyClosed: false,
        endOfStreamCalled: false,
        aborted: false,
        reader: null,
        reachedEof: false,
        detachPlaying: null,
        deadlineTimer: null,
        readerAcquired: false,
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
        // Cancel via reader once acquired — never body.cancel while locked.
        const reader = state.reader;
        state.reader = null;
        if (reader) {
            releaseReader(reader);
        } else if (!state.readerAcquired) {
            cancelReadableStreamBody(body);
        }
        try { audio.pause(); } catch { /* ignore */ }
        try {
            if (audio.src) audio.removeAttribute('src');
            audio.load();
        } catch { /* ignore */ }
        try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
        options.signal?.removeEventListener?.('abort', onOuterAbort);
    };

    let settled = false;
    let settleResolve;
    const settledPromise = new Promise((resolve) => { settleResolve = resolve; });
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

        state.onStreamError = (error) => {
            finish(progressiveTtfaUnavailable({
                usedMediaSource: true,
                mimeType,
                reason: 'Progressive MediaSource stream failed: ' +
                    String(error?.message || error),
            }));
        };

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
            // Progressive TTFA requires playing before the pump has drained
            // the body (read done). Pending append of an already-read chunk
            // still counts — reader.closed alone is too early (see pump).
            if (state.bodyClosed) {
                finish(progressiveTtfaUnavailable({
                    usedMediaSource: true,
                    mimeType,
                    reason: 'Playback started after stream EOF ' +
                        '(post-download, not progressive MediaSource TTFA)',
                    playedBeforeEof: false,
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
