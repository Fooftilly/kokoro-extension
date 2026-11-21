/**
 * @jest-environment jsdom
 *
 * Executing runtime coverage for measureProgressiveMediaSourceTtfa:
 * stalled-stream deadline, playing-before-EOF (measured), playing-after-EOF
 * (unavailable), and locked-stream cancel without unhandled rejection.
 */

function installMediaSourceStub({ playAfterMs = 5, firePlaying = true } = {}) {
    class StubSourceBuffer extends EventTarget {
        constructor() {
            super();
            this.updating = false;
        }
        appendBuffer() {
            this.updating = true;
            queueMicrotask(() => {
                this.updating = false;
                this.dispatchEvent(new Event('updateend'));
            });
        }
    }
    class StubMediaSource extends EventTarget {
        constructor() {
            super();
            this.readyState = 'closed';
            this.endOfStreamCalls = 0;
            queueMicrotask(() => {
                this.readyState = 'open';
                this.dispatchEvent(new Event('sourceopen'));
            });
        }
        addSourceBuffer() {
            return new StubSourceBuffer();
        }
        endOfStream() {
            this.endOfStreamCalls += 1;
            this.readyState = 'ended';
        }
        static isTypeSupported(mime) {
            return String(mime || '').startsWith('audio/mpeg');
        }
    }
    global.MediaSource = StubMediaSource;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:mse-ttfa-test';
    URL.revokeObjectURL = () => {};

    const origCreateElement = document.createElement.bind(document);
    document.createElement = (tag) => {
        const el = origCreateElement(tag);
        if (String(tag).toLowerCase() === 'audio') {
            el.pause = () => {};
            el.load = () => {};
            el.play = () => {
                if (firePlaying) {
                    setTimeout(() => el.dispatchEvent(new Event('playing')),
                        playAfterMs);
                }
                return Promise.resolve();
            };
        }
        return el;
    };

    return {
        restore() {
            document.createElement = origCreateElement;
            URL.createObjectURL = origCreate;
            URL.revokeObjectURL = origRevoke;
            delete global.MediaSource;
        },
    };
}

function controllableStream(chunks, { hangAfter = null } = {}) {
    let index = 0;
    let cancelCount = 0;
    let releaseLockCount = 0;
    let pendingReject = null;
    return {
        getReader() {
            return {
                async read() {
                    if (hangAfter != null && index >= hangAfter) {
                        await new Promise((_, reject) => {
                            pendingReject = reject;
                        });
                    }
                    if (index >= chunks.length) {
                        return { done: true, value: undefined };
                    }
                    const value = chunks[index++];
                    return { done: false, value };
                },
                cancel() {
                    cancelCount += 1;
                    if (pendingReject) {
                        pendingReject(new Error('stream cancelled'));
                        pendingReject = null;
                    }
                    return Promise.resolve();
                },
                releaseLock() {
                    releaseLockCount += 1;
                },
            };
        },
        cancel() {
            cancelCount += 1;
            return Promise.reject(new TypeError('ReadableStream is locked'));
        },
        get cancelCount() { return cancelCount; },
        get releaseLockCount() { return releaseLockCount; },
    };
}

describe('measureProgressiveMediaSourceTtfa runtime', () => {
    let mse;
    let stub;

    beforeEach(async () => {
        jest.resetModules();
        stub = installMediaSourceStub({ playAfterMs: 8, firePlaying: true });
        mse = await import('../mediasource-progressive-ttfa.js');
    });

    afterEach(() => {
        stub?.restore();
    });

    test('stalled stream times out unavailable and cancels pending reader', async () => {
        stub.restore();
        stub = installMediaSourceStub({ firePlaying: false });
        jest.resetModules();
        mse = await import('../mediasource-progressive-ttfa.js');

        const body = controllableStream(
            [new Uint8Array([1, 2, 3])],
            { hangAfter: 1 });
        const unhandled = [];
        const onUnhandled = (reason) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);

        const result = await mse.measureProgressiveMediaSourceTtfa({
            body,
            startedAt: 0,
            timeoutMs: 40,
        });

        process.removeListener('unhandledRejection', onUnhandled);
        expect(result.measured).toBe(false);
        expect(result.unavailable).toBe(true);
        expect(result.ttfaMs).toBeNull();
        expect(result.reason).toMatch(/timed out/i);
        expect(body.cancelCount).toBeGreaterThanOrEqual(1);
        expect(body.releaseLockCount).toBeGreaterThanOrEqual(1);
        expect(unhandled).toEqual([]);
    });

    test('playing before EOF returns measured progressive TTFA', async () => {
        const body = controllableStream(
            [new Uint8Array([10, 11, 12]), new Uint8Array([13])],
            { hangAfter: 1 });
        const result = await mse.measureProgressiveMediaSourceTtfa({
            body,
            startedAt: performance.now() - 25,
            timeoutMs: 500,
        });
        expect(result.measured).toBe(true);
        expect(result.unavailable).toBe(false);
        expect(Number.isFinite(result.ttfaMs)).toBe(true);
        expect(result.ttfaMs).toBeGreaterThanOrEqual(0);
        expect(result.playedBeforeEof).toBe(true);
        expect(result.usedMediaSource).toBe(true);
    });

    test('playing after EOF returns unavailable (not progressive TTFA)', async () => {
        stub.restore();
        stub = installMediaSourceStub({ playAfterMs: 60, firePlaying: true });
        jest.resetModules();
        mse = await import('../mediasource-progressive-ttfa.js');

        const body = controllableStream([new Uint8Array([1, 2, 3, 4])]);
        const result = await mse.measureProgressiveMediaSourceTtfa({
            body,
            startedAt: performance.now(),
            timeoutMs: 500,
        });
        expect(result.measured).toBe(false);
        expect(result.unavailable).toBe(true);
        expect(result.ttfaMs).toBeNull();
        expect(result.playedBeforeEof).toBe(false);
        expect(String(result.reason || '')).toMatch(
            /after stream EOF|post-download/i);
    });

    test('cleanup does not reject when body is locked by reader', async () => {
        stub.restore();
        stub = installMediaSourceStub({ firePlaying: false });
        jest.resetModules();
        mse = await import('../mediasource-progressive-ttfa.js');

        const body = controllableStream(
            [new Uint8Array([9])],
            { hangAfter: 1 });
        const unhandled = [];
        const onUnhandled = (r) => { unhandled.push(String(r)); };
        process.on('unhandledRejection', onUnhandled);

        const result = await mse.measureProgressiveMediaSourceTtfa({
            body,
            startedAt: 0,
            timeoutMs: 30,
        });

        await new Promise((r) => setTimeout(r, 20));
        process.removeListener('unhandledRejection', onUnhandled);

        expect(result.unavailable).toBe(true);
        expect(unhandled.filter((m) => /locked/i.test(m))).toEqual([]);
    });
});
