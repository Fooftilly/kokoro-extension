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

    test('page refuses MSE handoff when remainingMs <= 0 (source wiring)', () => {
        // Prefer source asserts over a duplicated handoff mirror (Devin ANALYSIS).
        const remainIdx = progressiveFn.indexOf('remainingMs <= 0');
        const measureIdx = progressiveFn.indexOf(
            'measureProgressiveMediaSourceTtfa({');
        expect(remainIdx).toBeGreaterThanOrEqual(0);
        expect(remainIdx).toBeLessThan(measureIdx);
        const exhaustedBlock = progressiveFn.slice(remainIdx, measureIdx);
        expect(exhaustedBlock).toContain('cancelReadableStreamBody(response.body)');
        expect(exhaustedBlock).toContain('abortController.abort()');
        expect(exhaustedBlock).toContain(
            'Progressive MediaSource TTFA timed out after');
        expect(exhaustedBlock).toContain('progressiveTtfaUnavailable');
        // Must not hand timeoutMs:0 into the measurer from this branch.
        expect(exhaustedBlock).not.toContain('measureProgressiveMediaSourceTtfa');
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
