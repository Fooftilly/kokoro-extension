// Shared jsdom stand-in for the extension-origin Web Locks API.
// Scheduling and cancellation semantics are verified in model-data-lock.test.js.
// These suites need only an immediate lock to exercise their own behavior.
export function installImmediateModelLocks() {
    const locks = {
        request: jest.fn(async (name, options, work) => {
            if (options?.signal?.aborted) {
                throw new DOMException('Model operation cancelled', 'AbortError');
            }
            return work();
        }),
    };
    Object.defineProperty(global.navigator, 'locks', {
        configurable: true,
        value: locks,
    });
    return locks;
}
