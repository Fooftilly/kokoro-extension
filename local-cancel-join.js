/**
 * Local cancel-join measurement (#57 / KE-61).
 * Wall time from cancel() until an in-flight synthesize settles.
 * Requires the engine to fire onInferenceStarted once native inference is
 * about to begin; otherwise the metric stays unmeasured (fail closed).
 *
 * Use a short English probe for cancel-join. MediaPipe cancel is best-effort
 * and ONNX cannot abort an active session.run(), so join latency tracks full
 * synth time — a long shared-sample probe stalls Chromium dual (180s heartbeat).
 */
export const CANCEL_JOIN_PROBE_TEXT = 'Cancel join probe.';

/**
 * @param {{ cancel: Function, onInferenceStarted?: Function }} engine
 * @param {() => Promise<unknown>} synthesize
 * @returns {Promise<number[]>} three nonnegative join latencies (ms)
 */
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
            // Clock starts at the cancel request, ends when synthesize settles
            // (not when cancel() itself resolves). Non-AbortError failures are
            // not cancel-join measurements.
            const t0 = performance.now();
            const cancelPromise = Promise.resolve().then(() => engine.cancel());
            let settledAt = null;
            await pending.then(
                () => { settledAt = performance.now(); },
                (error) => {
                    const name = error && error.name;
                    if (name !== 'AbortError') throw error;
                    settledAt = performance.now();
                },
            );
            await cancelPromise.catch(() => {});
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
