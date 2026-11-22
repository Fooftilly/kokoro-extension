/**
 * Cancel-join must wait for in-flight inference and time cancel→settle only.
 */
const { measureCancelJoin } = require('../local-cancel-join.js');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('local cancel-join measurement', () => {
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
        const [join] = await measureCancelJoin(engine, synthesize);
        expect(Math.abs(join - (settledAt - cancelAt))).toBeLessThan(8);
        expect(join).toBeGreaterThan(10);
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
});
