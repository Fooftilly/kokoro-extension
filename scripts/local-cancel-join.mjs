/**
 * Node mirror of ../local-cancel-join.js for spawnSync contracts.
 * Keep behavior identical to the packaged browser helper.
 */
export const CANCEL_JOIN_PROBE_TEXT = 'Cancel join probe.';

export async function measureCancelJoin(engine, synthesize) {
    if (!engine || typeof engine.cancel !== 'function') {
        throw new TypeError('Local engine cancel() required for cancel-join');
    }
    if (typeof synthesize !== 'function') {
        throw new TypeError('synthesize() required for cancel-join');
    }
    const joins = [];
    for (let n = 0; n < 3; n++) {
        let resolveStarted;
        const startedGate = new Promise((resolve) => {
            resolveStarted = resolve;
        });
        let startedFired = false;
        const previousHook = engine.onInferenceStarted;
        engine.onInferenceStarted = () => {
            if (startedFired) return;
            startedFired = true;
            resolveStarted();
        };
        try {
            const pending = Promise.resolve().then(() => synthesize());
            const race = await Promise.race([
                startedGate.then(() => 'started'),
                pending.then(() => 'settled-early', () => 'settled-early'),
            ]);
            if (race !== 'started' || !startedFired) {
                throw new Error(
                    'Cancel join requires in-flight inference before cancel()');
            }
            const stillInFlight = await Promise.race([
                pending.then(() => false, () => false),
                Promise.resolve().then(() => true),
            ]);
            if (!stillInFlight) {
                throw new Error(
                    'Cancel join requires in-flight inference before cancel()');
            }
            const t0 = performance.now();
            const cancelOutcome = Promise.resolve()
                .then(() => engine.cancel())
                .then(
                    () => ({ ok: true }),
                    (error) => ({ ok: false, error }),
                );
            let settledAt = null;
            await pending.then(
                () => { settledAt = performance.now(); },
                (error) => {
                    const name = error && error.name;
                    if (name !== 'AbortError') throw error;
                    settledAt = performance.now();
                },
            );
            const cancelResult = await cancelOutcome;
            if (!cancelResult.ok) {
                throw cancelResult.error instanceof Error
                    ? cancelResult.error
                    : new Error('Cancel request failed during join measurement');
            }
            const joinMs = settledAt - t0;
            if (!Number.isFinite(joinMs) || joinMs < 0) {
                throw new Error('Cancel join measurement failed');
            }
            joins.push(joinMs);
        } finally {
            engine.onInferenceStarted = previousHook;
        }
    }
    return joins;
}
