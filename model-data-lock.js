// Serialize Cache Storage mutation across extension tabs and workers, while
// allowing active local inference to share a read lease. The Web Locks API is
// origin-scoped in current Chrome and Firefox. No server, storage-based
// leader election, or timeouts that could break a live cache write.
export const MODEL_CACHE_LOCK = 'kokoro-model-data-v1';

export function withModelDataLock(work, {
    mode = 'exclusive', signal, lockManager = globalThis.navigator?.locks,
} = {}) {
    if (typeof work !== 'function' || !['shared', 'exclusive'].includes(mode)) {
        throw new TypeError('Invalid Kokoro model cache lock operation');
    }
    // Fail closed if an extension origin cannot coordinate local model data
    // safely across tabs. FastAPI operation does not depend on this API.
    if (!lockManager || typeof lockManager.request !== 'function') {
        throw new Error('Local model cache coordination requires Web Locks in this browser.');
    }
    return lockManager.request(MODEL_CACHE_LOCK, {
        mode, ...(signal ? { signal } : {}),
    }, async () => {
        if (signal?.aborted) throw new globalThis.DOMException('Model operation cancelled', 'AbortError');
        return work();
    });
}
