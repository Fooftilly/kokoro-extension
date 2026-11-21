/**
 * @jest-environment node
 *
 * Progressive FastAPI POST: abortable header timeout before fetch, and
 * HTTP error diagnostics read before any body cancel.
 * Mirrors measureFastApiProgressiveMediaSourceTtfa in model-manager-page.js.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pageSource = fs.readFileSync(
    path.join(root, 'model-manager-page.js'), 'utf8');
const mseSource = fs.readFileSync(
    path.join(root, 'mediasource-progressive-ttfa.js'), 'utf8');

const progressiveFn = pageSource.slice(
    pageSource.indexOf(
        'async function measureFastApiProgressiveMediaSourceTtfa'),
    pageSource.indexOf('async function fetchFastApiPlayableClip'));

/**
 * Mirror of progressive header-wait timeout (page is not exported).
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 */
async function progressiveFetchWithHeaderTimeout(fetchImpl, timeoutMs) {
    const abortController = new AbortController();
    let headerDeadlineTimer = null;
    if (timeoutMs > 0) {
        headerDeadlineTimer = setTimeout(() => {
            try { abortController.abort(); } catch { /* ignore */ }
        }, timeoutMs);
    }
    try {
        try {
            const response = await fetchImpl('http://hang/v1/audio/speech', {
                method: 'POST',
                signal: abortController.signal,
            });
            return { ok: true, response };
        } catch (error) {
            return {
                measured: false,
                unavailable: true,
                ttfaMs: null,
                reason: 'Progressive MediaSource fetch failed: ' +
                    String(error?.message || error),
            };
        }
    } finally {
        if (headerDeadlineTimer != null) clearTimeout(headerDeadlineTimer);
    }
}

/**
 * Mirror of post-headers remaining-budget handoff (page is not exported).
 * Models headers arriving past deadline while abort callback is still queued.
 */
function progressiveHandoffAfterHeaders({
    startedAt,
    timeoutMs,
    now,
    body,
    cancelBody,
    abort,
}) {
    const remainingMs = timeoutMs - (now - startedAt);
    if (remainingMs <= 0) {
        cancelBody(body);
        abort();
        return {
            measured: false,
            unavailable: true,
            ttfaMs: null,
            reason: 'Progressive MediaSource TTFA timed out after ' +
                timeoutMs + 'ms',
            handedOff: false,
        };
    }
    return { handedOff: true, timeoutMs: remainingMs };
}

describe('progressive FastAPI fetch header timeout', () => {
    test('page arms abortable deadline before progressive fetch()', () => {
        expect(progressiveFn).toContain('DEFAULT_PROGRESSIVE_TTFA_TIMEOUT_MS');
        expect(progressiveFn).toContain('headerDeadlineTimer');
        expect(progressiveFn).toContain('abortController.abort()');
        const timerIdx = progressiveFn.indexOf('headerDeadlineTimer = setTimeout');
        const fetchIdx = progressiveFn.indexOf('await fetch(endpoint');
        expect(timerIdx).toBeGreaterThanOrEqual(0);
        expect(fetchIdx).toBeGreaterThan(timerIdx);
        expect(progressiveFn).toContain('clearTimeout(headerDeadlineTimer)');
    });

    test('never-resolving fetch → progressive unavailable (playable independent)',
        async () => {
            let playableCalls = 0;
            const playableClip = async () => {
                playableCalls += 1;
                return {
                    firstBodyByteMs: 90,
                    synthesisMs: 140,
                    playbackStartMs: 160,
                };
            };
            // Mimic fetch: never resolves until AbortSignal fires.
            const hangFetch = (_url, opts = {}) => new Promise((_resolve, reject) => {
                const signal = opts.signal;
                if (!signal) return;
                if (signal.aborted) {
                    reject(new DOMException(
                        'The operation was aborted', 'AbortError'));
                    return;
                }
                signal.addEventListener('abort', () => {
                    reject(new DOMException(
                        'The operation was aborted', 'AbortError'));
                }, { once: true });
            });
            const started = Date.now();
            const progressive = await progressiveFetchWithHeaderTimeout(
                hangFetch, 40);
            const elapsed = Date.now() - started;
            const clip = await playableClip();
            expect(progressive.unavailable).toBe(true);
            expect(progressive.measured).toBe(false);
            expect(progressive.ttfaMs).toBeNull();
            expect(progressive.reason).toMatch(
                /Progressive MediaSource fetch failed/i);
            expect(elapsed).toBeGreaterThanOrEqual(30);
            expect(elapsed).toBeLessThan(2000);
            expect(playableCalls).toBe(1);
            expect(clip.firstBodyByteMs).toBe(90);
        });

    test('page refuses MSE handoff when remainingMs <= 0', () => {
        expect(progressiveFn).toContain('remainingMs <= 0');
        expect(progressiveFn).toContain(
            'Progressive MediaSource TTFA timed out after');
        const remainIdx = progressiveFn.indexOf('remainingMs <= 0');
        const measureIdx = progressiveFn.indexOf(
            'measureProgressiveMediaSourceTtfa({');
        expect(remainIdx).toBeGreaterThanOrEqual(0);
        expect(remainIdx).toBeLessThan(measureIdx);
    });

    test('past-deadline handoff with abort still queued → unavailable', () => {
        let bodyCancelCount = 0;
        let abortCount = 0;
        let measureCalls = 0;
        const body = { cancel() { bodyCancelCount += 1; } };
        // Headers arrive 1ms past deadline; abort setTimeout still pending.
        const startedAt = 1000;
        const timeoutMs = 15000;
        const now = startedAt + timeoutMs + 1;
        const abortQueued = setTimeout(() => { abortCount += 1; }, 50);
        const result = progressiveHandoffAfterHeaders({
            startedAt,
            timeoutMs,
            now,
            body,
            cancelBody: (b) => { b.cancel(); },
            abort: () => { abortCount += 1; },
        });
        clearTimeout(abortQueued);
        if (result.handedOff) measureCalls += 1;
        expect(result.unavailable).toBe(true);
        expect(result.measured).toBe(false);
        expect(result.ttfaMs).toBeNull();
        expect(result.handedOff).toBe(false);
        expect(result.reason).toMatch(
            /Progressive MediaSource TTFA timed out after 15000ms/);
        expect(bodyCancelCount).toBe(1);
        expect(abortCount).toBe(1);
        expect(measureCalls).toBe(0);
    });
});

describe('progressive HTTP error body diagnostics', () => {
    test('page reads bounded error text before any body cancel', () => {
        expect(progressiveFn).toContain('readBoundedResponseText');
        const errIdx = progressiveFn.indexOf('if (!response.ok)');
        const readIdx = progressiveFn.indexOf(
            'readBoundedResponseText(', errIdx);
        expect(errIdx).toBeGreaterThanOrEqual(0);
        expect(readIdx).toBeGreaterThan(errIdx);
        // Must not cancel before reading on the HTTP-error path.
        const errBlock = progressiveFn.slice(
            errIdx,
            progressiveFn.indexOf(
                'if (!probeMediaSourceProgressiveMp3Support()', errIdx));
        expect(errBlock).toContain('readBoundedResponseText(');
        expect(errBlock).toContain('abortController.signal');
        expect(errBlock).not.toContain('cancelReadableStreamBody');
    });

    test('readBoundedResponseText is exported and capped', () => {
        expect(mseSource).toContain('export async function readBoundedResponseText');
        expect(mseSource).toContain('PROGRESSIVE_HTTP_ERROR_BODY_LIMIT');
    });
});
