/** @jest-environment node */
import { withModelDataLock, MODEL_CACHE_LOCK } from '../model-data-lock.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
};

// Deterministic miniature origin-wide lock scheduler shared between fake tabs.
// It implements the exclusive/shared and queued-abort behavior used by the API.
function createLockManager() {
    const queue = [];
    let shared = 0;
    let exclusive = false;
    function pump() {
        if (exclusive) return;
        while (queue.length) {
            const next = queue[0];
            if (next.options.mode === 'exclusive' && shared) return;
            queue.shift();
            if (next.cancelled) continue;
            if (next.options.mode === 'exclusive') exclusive = true;
            else shared++;
            Promise.resolve().then(next.work).then(next.resolve, next.reject).finally(() => {
                if (next.options.mode === 'exclusive') exclusive = false;
                else shared--;
                pump();
            });
            if (exclusive) return;
        }
    }
    const request = jest.fn((name, options, work) => {
        if (name !== MODEL_CACHE_LOCK) throw new Error('Wrong cache lock');
        return new Promise((resolve, reject) => {
            if (options.signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            const job = { options, work, resolve, reject, cancelled: false };
            options.signal?.addEventListener('abort', () => {
                if (!queue.includes(job)) return;
                job.cancelled = true;
                queue.splice(queue.indexOf(job), 1);
                reject(new DOMException('Aborted', 'AbortError'));
                pump();
            }, { once: true });
            queue.push(job);
            pump();
        });
    });
    return { request };
}

describe('model-cache Web Locks across extension contexts', () => {
    test('multiple readers can run, while a writer waits for both readers', async () => {
        const lockManager = createLockManager();
        const gate = deferred();
        const entered = [];
        const a = withModelDataLock(async () => {
            entered.push('read-a');
            await gate.promise;
        }, { mode: 'shared', lockManager });
        const b = withModelDataLock(async () => {
            entered.push('read-b');
            await gate.promise;
        }, { mode: 'shared', lockManager });
        const write = withModelDataLock(async () => { entered.push('write'); }, { lockManager });
        await Promise.resolve();
        expect(entered).toEqual(['read-a', 'read-b']);
        expect(lockManager.request.mock.calls.map(([, options]) => options.mode))
            .toEqual(['shared', 'shared', 'exclusive']);
        gate.resolve();
        await Promise.all([a, b, write]);
        expect(entered).toEqual(['read-a', 'read-b', 'write']);
    });

    test('writer prevents a second tab from initializing a reader until commit ends', async () => {
        const lockManager = createLockManager();
        const gate = deferred();
        let started = false;
        const writing = withModelDataLock(async () => {
            await gate.promise;
            return 'committed';
        }, { lockManager });
        const reading = withModelDataLock(async () => { started = true; }, {
            mode: 'shared', lockManager,
        });
        await Promise.resolve();
        expect(started).toBe(false);
        gate.resolve();
        await writing;
        await reading;
        expect(started).toBe(true);
    });

    test('an aborted queued download never enters its mutation callback', async () => {
        const lockManager = createLockManager();
        const gate = deferred();
        const reading = withModelDataLock(() => gate.promise, { mode: 'shared', lockManager });
        const controller = new AbortController();
        const operation = jest.fn();
        const installing = withModelDataLock(operation, {
            signal: controller.signal, lockManager,
        });
        controller.abort();
        await expect(installing).rejects.toMatchObject({ name: 'AbortError' });
        gate.resolve();
        await reading;
        expect(operation).not.toHaveBeenCalled();
    });

    test('invalid lock mode and missing browser support fail closed', async () => {
        expect(() => withModelDataLock(() => {}, { mode: 'bad' })).toThrow(TypeError);
        expect(() => withModelDataLock(() => {}, { lockManager: null }))
            .toThrow(/requires Web Locks/);
        const lockManager = createLockManager();
        const aborted = new AbortController();
        aborted.abort();
        await expect(withModelDataLock(() => {}, { signal: aborted.signal, lockManager }))
            .rejects.toMatchObject({ name: 'AbortError' });
    });
});
