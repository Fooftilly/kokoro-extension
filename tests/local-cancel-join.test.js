/**
 * Cancel-join must wait for in-flight inference and time cancel→settle only.
 */
const {
    CANCEL_JOIN_PROBE_TEXT,
    measureCancelJoin,
} = require('../local-cancel-join.js');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('local cancel-join measurement', () => {
    test('exports a short cancel probe for non-interruptible backends', () => {
        expect(CANCEL_JOIN_PROBE_TEXT).toMatch(/cancel join probe/i);
        expect(CANCEL_JOIN_PROBE_TEXT.length).toBeLessThan(40);
    });

    test('waits for inference and times cancel→settle only', async () => {
        const engine = {
            cancel: jest.fn(async () => { await delay(1); }),
        };
        const synthesize = jest.fn(async () => {
            if (typeof engine.onInferenceStarted === 'function') {
                engine.onInferenceStarted();
            }
            await delay(20);
            return { ok: true };
        });
        const joins = await measureCancelJoin(engine, synthesize);
        expect(joins).toHaveLength(3);
        expect(joins.every(v => Number.isFinite(v) && v >= 0)).toBe(true);
        expect(engine.cancel).toHaveBeenCalledTimes(3);
        expect(synthesize).toHaveBeenCalledTimes(3);
    });

    test('fails closed when inference never starts', async () => {
        const bare = { cancel: jest.fn(async () => {}) };
        await expect(measureCancelJoin(bare, async () => {
            await delay(5);
            return {};
        })).rejects.toThrow(/in-flight inference/i);
    });

    test('clock starts at cancel and ends at synthesize settle', async () => {
        let cancelAt = 0;
        let settledAt = 0;
        const engine = {
            cancel: jest.fn(async () => { cancelAt = performance.now(); }),
        };
        const synthesize = async () => {
            if (typeof engine.onInferenceStarted === 'function') {
                engine.onInferenceStarted();
            }
            await delay(30);
            settledAt = performance.now();
            return {};
        };
        // Three trials overwrite cancelAt/settledAt; compare the last join.
        const joins = await measureCancelJoin(engine, synthesize);
        const join = joins[joins.length - 1];
        expect(Math.abs(join - (settledAt - cancelAt))).toBeLessThan(8);
        expect(join).toBeGreaterThan(10);
    });

    test('rejects when synthesis settles before cancel()', async () => {
        const engine = { cancel: jest.fn(async () => {}) };
        const synthesize = async () => {
            if (typeof engine.onInferenceStarted === 'function') {
                engine.onInferenceStarted();
            }
            // Sync return after start → pending settles before cancel step.
            return {};
        };
        await expect(measureCancelJoin(engine, synthesize))
            .rejects.toThrow(/in-flight inference/i);
        expect(engine.cancel).not.toHaveBeenCalled();
    });

    test('rejects when synthesize finishes across a short microtask chain', async () => {
        const engine = { cancel: jest.fn(async () => {}) };
        const synthesize = async () => {
            if (typeof engine.onInferenceStarted === 'function') {
                engine.onInferenceStarted();
            }
            // Two post-start microtasks — settles before flush + same-step cancel
            // when synthDone is coupled to synthesize finally (not wrapper .then).
            await Promise.resolve();
            await Promise.resolve();
            return {};
        };
        await expect(measureCancelJoin(engine, synthesize))
            .rejects.toThrow(/in-flight inference/i);
        expect(engine.cancel).not.toHaveBeenCalled();
    });

    test('invokes cancel() synchronously while still in flight', async () => {
        let inFlight = 0;
        let cancelWhilePending = 0;
        const engine = {
            cancel: jest.fn(() => {
                if (inFlight > 0) cancelWhilePending += 1;
            }),
        };
        const synthesize = async () => {
            inFlight += 1;
            if (typeof engine.onInferenceStarted === 'function') {
                engine.onInferenceStarted();
            }
            // Stay pending across the helper flush without a timer.
            for (let i = 0; i < 8; i++) await Promise.resolve();
            inFlight -= 1;
            return {};
        };
        await measureCancelJoin(engine, synthesize);
        expect(engine.cancel).toHaveBeenCalledTimes(3);
        expect(cancelWhilePending).toBe(3);
    });

    test('AbortError settlement counts; other failures rethrow', async () => {
        const engine = { cancel: jest.fn(async () => {}) };
        const aborting = async () => {
            if (typeof engine.onInferenceStarted === 'function') {
                engine.onInferenceStarted();
            }
            await delay(5);
            const err = new Error('cancelled');
            err.name = 'AbortError';
            throw err;
        };
        const joins = await measureCancelJoin(engine, aborting);
        expect(joins).toHaveLength(3);

        const failing = async () => {
            if (typeof engine.onInferenceStarted === 'function') {
                engine.onInferenceStarted();
            }
            await delay(5);
            throw new Error('boom');
        };
        await expect(measureCancelJoin(engine, failing))
            .rejects.toThrow(/boom/);
    });

    test('rejecting cancel() invalidates join (does not export latency)', async () => {
        const engine = {
            cancel: jest.fn(async () => {
                throw new Error('cancel failed');
            }),
        };
        const synthesize = async () => {
            if (typeof engine.onInferenceStarted === 'function') {
                engine.onInferenceStarted();
            }
            await delay(30);
            return { ok: true };
        };
        await expect(measureCancelJoin(engine, synthesize))
            .rejects.toThrow(/cancel failed/);
        expect(engine.cancel).toHaveBeenCalled();
    });
});
