/**
 * @jest-environment jsdom
 */

import { webcrypto } from 'crypto';
import { TextEncoder } from 'util';
import {
    STORAGE_KEY,
    MAX_STORED_DOCUMENTS,
    documentIdFromDigest,
    hexDigestFromBuffer,
    buildProgressRecord,
    shouldAcceptProgressWrite,
    shouldPersistProgressUpdate,
    shouldOfferResumeChoice,
    resolveResumeTarget,
    planProgressUpsert,
    planProgressRemove,
    reconcileProgressRemoves,
    runExclusiveProgressMutation,
    applyProgressUpsertMutation,
    isResumeLookupStillCurrent,
    progressStorageKey,
    upsertProgress,
    removeProgress,
    clearAllProgress,
    fingerprintChapterBlocks,
    readProgressRecord,
} from '../reader-progress.js';

/** Minimal exclusive LockManager for serializing overlapping mutation tests. */
function createSerialLockManager() {
    let held = false;
    const waiters = [];
    return {
        request(_name, _opts, callback) {
            return new Promise((resolve, reject) => {
                const run = () => {
                    held = true;
                    Promise.resolve()
                        .then(() => callback())
                        .then(resolve, reject)
                        .finally(() => {
                            held = false;
                            const next = waiters.shift();
                            if (next) next();
                        });
                };
                if (held) waiters.push(run);
                else run();
            });
        },
    };
}

function digest(hex = 'a'.repeat(64)) {
    return hex;
}

/** Two-doc fixture used by migration / multi-tab upsert tests. */
function twoDocProgressRecords(overrides = {}) {
    const idA = documentIdFromDigest('a'.repeat(64));
    const idB = documentIdFromDigest('b'.repeat(64));
    const recordA = buildProgressRecord({
        documentId: idA, name: 'a.epub', size: 1, format: 'epub',
        chapterHref: 'a.xhtml', blockIndex: 1, chapterFingerprint: 'fp',
        revision: 1, updatedAt: 1,
        ...overrides.a,
    });
    const recordB = buildProgressRecord({
        documentId: idB, name: 'b.epub', size: 1, format: 'epub',
        chapterHref: 'b.xhtml', blockIndex: 2, chapterFingerprint: 'fp',
        revision: 1, updatedAt: 2,
        ...overrides.b,
    });
    return { idA, idB, recordA, recordB };
}

describe('reader-progress helpers (#196)', () => {
    beforeAll(() => {
        Object.defineProperty(globalThis, 'crypto', {
            value: webcrypto,
            configurable: true,
        });
    });

    test('documentIdFromDigest prefixes a stable sha256 id', () => {
        expect(documentIdFromDigest(digest())).toBe('sha256:' + 'a'.repeat(64));
        expect(() => documentIdFromDigest('not-hex')).toThrow(/digest/i);
    });

    test('hexDigestFromBuffer hashes ArrayBuffer bytes', async () => {
        const bytes = new TextEncoder().encode('kokoro-reader');
        const hex = await hexDigestFromBuffer(bytes.buffer);
        expect(hex).toMatch(/^[a-f0-9]{64}$/);
        const again = await hexDigestFromBuffer(bytes.buffer);
        expect(again).toBe(hex);
        const other = await hexDigestFromBuffer(new TextEncoder().encode('other').buffer);
        expect(other).not.toBe(hex);
    });

    test('fingerprintChapterBlocks is stable for the same blocks', () => {
        const blocks = [
            { content: 'Hello world.', ids: ['a'] },
            { content: 'Second.', ids: [] },
        ];
        const a = fingerprintChapterBlocks(blocks);
        const b = fingerprintChapterBlocks(blocks);
        expect(a).toBe(b);
        expect(a).toMatch(/^[a-f0-9]{16,}$/);
        expect(fingerprintChapterBlocks([
            { content: 'Hello world!', ids: ['a'] },
        ])).not.toBe(a);
    });

    test('buildProgressRecord stores validated fields without source text', () => {
        const record = buildProgressRecord({
            documentId: documentIdFromDigest(digest()),
            name: 'book.epub',
            size: 12,
            format: 'epub',
            chapterHref: 'ch1.xhtml#intro',
            blockIndex: 3,
            chapterFingerprint: 'abc',
            revision: 7,
            updatedAt: 1000,
        });
        expect(record).toEqual(expect.objectContaining({
            documentId: 'sha256:' + 'a'.repeat(64),
            name: 'book.epub',
            size: 12,
            format: 'epub',
            chapterHref: 'ch1.xhtml#intro',
            blockIndex: 3,
            chapterFingerprint: 'abc',
            revision: 7,
            updatedAt: 1000,
        }));
        expect(JSON.stringify(record)).not.toMatch(/Hello|pendingText|content/);
    });

    test('shouldPersistProgressUpdate blocks overlay init while resume is pending', () => {
        expect(shouldPersistProgressUpdate({ resumeDecisionPending: true })).toBe(false);
        expect(shouldPersistProgressUpdate({ resumeDecisionPending: false })).toBe(true);
    });

    test('shouldOfferResumeChoice at block zero only for non-first chapters', () => {
        expect(shouldOfferResumeChoice({
            ok: true, blockIndex: 0, chapterHref: 'later.xhtml',
        }, 'first.xhtml')).toBe(true);
        expect(shouldOfferResumeChoice({
            ok: true, blockIndex: 0, chapterHref: 'first.xhtml',
        }, 'first.xhtml')).toBe(false);
        expect(shouldOfferResumeChoice({
            ok: true, blockIndex: 3, chapterHref: 'first.xhtml',
        }, 'first.xhtml')).toBe(true);
        expect(shouldOfferResumeChoice({ ok: false, blockIndex: 0 }, 'first.xhtml')).toBe(false);
    });

    test('fingerprint ignores continuous-reader playback truncation when using canonical blocks', () => {
        const full = [
            { content: 'A.', ids: ['a'] },
            { content: 'B.', ids: ['b'] },
            { content: 'C.', ids: ['c'] },
        ];
        const truncated = full.slice(0, 2);
        expect(fingerprintChapterBlocks(truncated)).not.toBe(fingerprintChapterBlocks(full));
        // Save/restore must both use the canonical (full) set.
        expect(fingerprintChapterBlocks(full)).toBe(fingerprintChapterBlocks(full.slice()));
    });

    test('shouldAcceptProgressWrite fences stale document and chapter revisions', () => {
        expect(shouldAcceptProgressWrite({
            writeRevision: 2,
            currentRevision: 2,
            writeChapterRequestId: 5,
            currentChapterRequestId: 5,
            writeDocumentId: 'sha256:aa',
            currentDocumentId: 'sha256:aa',
        })).toBe(true);

        expect(shouldAcceptProgressWrite({
            writeRevision: 1,
            currentRevision: 2,
            writeChapterRequestId: 5,
            currentChapterRequestId: 5,
            writeDocumentId: 'sha256:aa',
            currentDocumentId: 'sha256:aa',
        })).toBe(false);

        expect(shouldAcceptProgressWrite({
            writeRevision: 2,
            currentRevision: 2,
            writeChapterRequestId: 4,
            currentChapterRequestId: 5,
            writeDocumentId: 'sha256:aa',
            currentDocumentId: 'sha256:aa',
        })).toBe(false);

        expect(shouldAcceptProgressWrite({
            writeRevision: 2,
            currentRevision: 2,
            writeChapterRequestId: 5,
            currentChapterRequestId: 5,
            writeDocumentId: 'sha256:old',
            currentDocumentId: 'sha256:new',
        })).toBe(false);
    });

    test('resolveResumeTarget validates chapter href and block index', () => {
        const flatToc = [
            { href: 'a.xhtml', label: 'A' },
            { href: 'b.xhtml#mid', label: 'B' },
        ];
        const record = buildProgressRecord({
            documentId: documentIdFromDigest(digest()),
            name: 'book.epub',
            size: 1,
            format: 'epub',
            chapterHref: 'b.xhtml#mid',
            blockIndex: 2,
            chapterFingerprint: 'fp1',
            revision: 1,
            updatedAt: 1,
        });

        expect(resolveResumeTarget({
            record,
            flatToc,
            chapterFingerprint: 'fp1',
            chapterBlockCount: 5,
        })).toEqual({
            ok: true,
            chapterHref: 'b.xhtml#mid',
            blockIndex: 2,
            label: 'B',
        });

        expect(resolveResumeTarget({
            record,
            flatToc,
            chapterFingerprint: 'changed',
            chapterBlockCount: 5,
        }).ok).toBe(false);

        expect(resolveResumeTarget({
            record: { ...record, blockIndex: 9 },
            flatToc,
            chapterFingerprint: 'fp1',
            chapterBlockCount: 5,
        }).ok).toBe(false);

        expect(resolveResumeTarget({
            record: { ...record, chapterHref: 'missing.xhtml' },
            flatToc,
            chapterFingerprint: 'fp1',
            chapterBlockCount: 5,
        }).ok).toBe(false);
    });

    test('upsertProgress replaces same id and bounds stored documents', () => {
        let store = {};
        const base = {
            name: 'n.epub', size: 1, format: 'epub',
            chapterHref: 'a.xhtml', blockIndex: 0,
            chapterFingerprint: 'fp', revision: 1, updatedAt: 1,
        };
        for (let i = 0; i < MAX_STORED_DOCUMENTS + 3; i++) {
            const hex = i.toString(16).padStart(64, '0');
            store = upsertProgress(store, buildProgressRecord({
                ...base,
                documentId: documentIdFromDigest(hex),
                updatedAt: i + 1,
                revision: i + 1,
            }));
        }
        const map = store[STORAGE_KEY] || {};
        expect(Object.keys(map).length).toBe(MAX_STORED_DOCUMENTS);
        const oldestHex = (0).toString(16).padStart(64, '0');
        expect(map[documentIdFromDigest(oldestHex)]).toBeUndefined();
    });

    test('planProgressUpsert keeps legacy peers in the map instead of writing peer keys', () => {
        const { idA, idB, recordA, recordB } = twoDocProgressRecords();
        const updatedA = buildProgressRecord({
            ...recordA, blockIndex: 5, updatedAt: 3, revision: 2,
        });
        const store = { [STORAGE_KEY]: { [idA]: recordA, [idB]: recordB } };
        const plan = planProgressUpsert(store, updatedA);
        expect(plan.set[progressStorageKey(idA)]).toEqual(updatedA);
        expect(plan.set[progressStorageKey(idB)]).toBeUndefined();
        expect(plan.set[STORAGE_KEY]).toEqual({ [idB]: recordB });
        expect(plan.remove).not.toContain(STORAGE_KEY);
        const after = { ...store, ...plan.set };
        for (const key of plan.remove) delete after[key];
        expect(readProgressRecord(after, idB).blockIndex).toBe(2);
        expect(readProgressRecord(after, idA).blockIndex).toBe(5);
    });

    test('planProgressUpsert does not rewrite peers that already have per-doc keys', () => {
        const { idA, idB, recordA, recordB } = twoDocProgressRecords();
        const updatedA = buildProgressRecord({
            ...recordA, blockIndex: 5, updatedAt: 3, revision: 2,
        });
        const store = {
            [progressStorageKey(idA)]: recordA,
            [progressStorageKey(idB)]: recordB,
        };
        const plan = planProgressUpsert(store, updatedA);
        expect(Object.keys(plan.set)).toEqual([progressStorageKey(idA)]);
        expect(plan.set[progressStorageKey(idB)]).toBeUndefined();
    });

    test('concurrent upserts from the same snapshot keep both latest values', () => {
        const { idA, idB, recordA, recordB } = twoDocProgressRecords();
        const recordA5 = buildProgressRecord({
            ...recordA, blockIndex: 5, updatedAt: 10, revision: 2,
        });
        const recordB7 = buildProgressRecord({
            ...recordB, blockIndex: 7, updatedAt: 11, revision: 2,
        });
        const store = {
            [progressStorageKey(idA)]: recordA,
            [progressStorageKey(idB)]: recordB,
        };
        const planA = planProgressUpsert(store, recordA5);
        const planB = planProgressUpsert(store, recordB7);

        function apply(order) {
            let next = { ...store };
            for (const plan of order) {
                Object.assign(next, plan.set);
                for (const key of plan.remove) delete next[key];
            }
            return next;
        }

        const aThenB = apply([planA, planB]);
        expect(readProgressRecord(aThenB, idA).blockIndex).toBe(5);
        expect(readProgressRecord(aThenB, idB).blockIndex).toBe(7);

        const bThenA = apply([planB, planA]);
        expect(readProgressRecord(bThenA, idA).blockIndex).toBe(5);
        expect(readProgressRecord(bThenA, idB).blockIndex).toBe(7);
    });

    test('planProgressRemove keeps leftover legacy peers without writing peer keys', () => {
        const { idA, idB, recordA, recordB } = twoDocProgressRecords();
        const store = { [STORAGE_KEY]: { [idA]: recordA, [idB]: recordB } };
        const plan = planProgressRemove(store, idA);
        expect(plan.remove).toEqual([progressStorageKey(idA)]);
        expect(plan.set[STORAGE_KEY]).toEqual({ [idB]: recordB });
        expect(plan.set[progressStorageKey(idB)]).toBeUndefined();
        const after = { ...store, ...plan.set };
        for (const key of plan.remove) delete after[key];
        expect(readProgressRecord(after, idB).blockIndex).toBe(2);
        expect(readProgressRecord(after, idA)).toBeNull();
    });

    test('concurrent legacy-only upserts keep both latest values in either order', () => {
        const { idA, idB, recordA, recordB } = twoDocProgressRecords();
        const recordA5 = buildProgressRecord({
            ...recordA, blockIndex: 5, updatedAt: 10, revision: 2,
        });
        const recordB7 = buildProgressRecord({
            ...recordB, blockIndex: 7, updatedAt: 11, revision: 2,
        });
        const store = { [STORAGE_KEY]: { [idA]: recordA, [idB]: recordB } };
        const planA = planProgressUpsert(store, recordA5);
        const planB = planProgressUpsert(store, recordB7);

        function apply(order) {
            let next = { ...store };
            for (const plan of order) {
                Object.assign(next, plan.set);
                for (const key of plan.remove) delete next[key];
            }
            return next;
        }

        for (const order of [[planA, planB], [planB, planA]]) {
            const after = apply(order);
            expect(readProgressRecord(after, idA).blockIndex).toBe(5);
            expect(readProgressRecord(after, idB).blockIndex).toBe(7);
            // Neither plan may write the peer's per-document key from the
            // shared legacy snapshot.
            expect(planA.set[progressStorageKey(idB)]).toBeUndefined();
            expect(planB.set[progressStorageKey(idA)]).toBeUndefined();
        }
    });

    test('isResumeLookupStillCurrent fences same-file recommit and failed selects', () => {
        const id = documentIdFromDigest('a'.repeat(64));
        const meta = { documentId: id, progressRevision: 3 };
        expect(isResumeLookupStillCurrent({
            capturedDocumentId: id,
            capturedProgressRevision: 3,
            currentMeta: meta,
        })).toBe(true);
        // Same file replaced — commit bumps progressRevision.
        expect(isResumeLookupStillCurrent({
            capturedDocumentId: id,
            capturedProgressRevision: 3,
            currentMeta: { documentId: id, progressRevision: 4 },
        })).toBe(false);
        // Different document committed.
        expect(isResumeLookupStillCurrent({
            capturedDocumentId: id,
            capturedProgressRevision: 3,
            currentMeta: {
                documentId: documentIdFromDigest('b'.repeat(64)),
                progressRevision: 1,
            },
        })).toBe(false);
        // Failed/cancelled selection never commits — revision unchanged.
        expect(isResumeLookupStillCurrent({
            capturedDocumentId: id,
            capturedProgressRevision: 3,
            currentMeta: meta,
        })).toBe(true);
    });

    test('clear revision bump rejects an in-flight progress write', () => {
        expect(shouldAcceptProgressWrite({
            writeRevision: 2,
            currentRevision: 3,
            writeChapterRequestId: 1,
            currentChapterRequestId: 1,
            writeDocumentId: 'sha256:' + 'a'.repeat(64),
            currentDocumentId: 'sha256:' + 'a'.repeat(64),
        })).toBe(false);
    });

    test('reconcileProgressRemoves drops eviction when a peer record was refreshed', () => {
        const store = {};
        const base = {
            name: 'n.epub', size: 1, format: 'epub',
            chapterHref: 'a.xhtml', blockIndex: 0,
            chapterFingerprint: 'fp', revision: 1,
        };
        const records = [];
        for (let i = 0; i < MAX_STORED_DOCUMENTS + 1; i++) {
            const hex = i.toString(16).padStart(64, '0');
            const record = buildProgressRecord({
                ...base,
                documentId: documentIdFromDigest(hex),
                updatedAt: i + 1,
                revision: i + 1,
            });
            records.push(record);
            store[progressStorageKey(record.documentId)] = record;
        }
        const newest = records[records.length - 1];
        const oldest = records[0];
        const plan = planProgressUpsert(store, newest);
        expect(plan.remove).toContain(progressStorageKey(oldest.documentId));

        // Peer tab refreshes the would-be-evicted document before remove applies.
        const refreshedOldest = buildProgressRecord({
            ...oldest, blockIndex: 3, updatedAt: newest.updatedAt + 10, revision: 2,
        });
        const afterPeer = {
            ...store,
            [progressStorageKey(newest.documentId)]: newest,
            [progressStorageKey(oldest.documentId)]: refreshedOldest,
        };
        const safe = reconcileProgressRemoves(plan.remove, afterPeer, newest);
        expect(safe).not.toContain(progressStorageKey(oldest.documentId));

        // Without an exclusive lock, a peer update *after* the fresh snapshot
        // still appears in the remove list — locks close that window.
        const staleSnapshot = {
            ...store,
            [progressStorageKey(newest.documentId)]: newest,
        };
        const stillEvicts = reconcileProgressRemoves(plan.remove, staleSnapshot, newest);
        expect(stillEvicts).toContain(progressStorageKey(oldest.documentId));
    });

    test('runExclusiveProgressMutation serializes overlapping tasks', async () => {
        const locks = createSerialLockManager();
        const order = [];
        const first = runExclusiveProgressMutation(async () => {
            order.push('a-start');
            await Promise.resolve();
            order.push('a-end');
        }, { locks });
        const second = runExclusiveProgressMutation(async () => {
            order.push('b-start');
            order.push('b-end');
        }, { locks });
        await Promise.all([first, second]);
        expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    });

    test('runExclusiveProgressMutation runs immediately without LockManager', async () => {
        const result = await runExclusiveProgressMutation(async () => 42, { locks: null });
        expect(result).toBe(42);
    });

    test('peer upsert after retention fresh-read waits for eviction under the lock', async () => {
        const locks = createSerialLockManager();
        const base = {
            name: 'n.epub', size: 1, format: 'epub',
            chapterHref: 'a.xhtml', blockIndex: 0,
            chapterFingerprint: 'fp', revision: 1,
        };
        const records = [];
        let store = {};
        for (let i = 0; i < MAX_STORED_DOCUMENTS + 1; i++) {
            const hex = i.toString(16).padStart(64, '0');
            const record = buildProgressRecord({
                ...base,
                documentId: documentIdFromDigest(hex),
                updatedAt: i + 1,
                revision: i + 1,
            });
            records.push(record);
            store[progressStorageKey(record.documentId)] = record;
        }
        const newest = records[records.length - 1];
        const oldest = records[0];
        const refreshedOldest = buildProgressRecord({
            ...oldest, blockIndex: 9, updatedAt: newest.updatedAt + 50, revision: 2,
        });

        let releaseFreshRead;
        const freshReadGate = new Promise((resolve) => { releaseFreshRead = resolve; });
        let atFreshRead = false;
        let getCount = 0;
        const storage = {
            getStore: async () => {
                getCount += 1;
                const snap = { ...store };
                // Second get is the post-set retention re-read.
                if (getCount === 2) {
                    atFreshRead = true;
                    await freshReadGate;
                }
                return snap;
            },
            setStore: async (patch) => { Object.assign(store, patch); },
            removeKeys: async (keys) => {
                for (const key of keys) delete store[key];
            },
        };

        const eviction = applyProgressUpsertMutation({
            record: newest,
            locks,
            ...storage,
        });
        for (let i = 0; i < 40 && !atFreshRead; i++) await Promise.resolve();
        expect(atFreshRead).toBe(true);

        let peerDone = false;
        const peer = applyProgressUpsertMutation({
            record: refreshedOldest,
            locks,
            getStore: async () => ({ ...store }),
            setStore: async (patch) => { Object.assign(store, patch); },
            removeKeys: async (keys) => {
                for (const key of keys) delete store[key];
            },
        }).then(() => { peerDone = true; });

        await Promise.resolve();
        await Promise.resolve();
        expect(peerDone).toBe(false);

        releaseFreshRead();
        await eviction;
        await peer;
        expect(peerDone).toBe(true);
        expect(readProgressRecord(store, oldest.documentId).blockIndex).toBe(9);
        expect(readProgressRecord(store, newest.documentId)).toEqual(newest);
    });

    test('removeProgress and clearAllProgress drop records', () => {
        const id = documentIdFromDigest(digest());
        let store = upsertProgress({}, buildProgressRecord({
            documentId: id,
            name: 'book.epub',
            size: 2,
            format: 'epub',
            chapterHref: 'a.xhtml',
            blockIndex: 1,
            chapterFingerprint: 'fp',
            revision: 1,
            updatedAt: 10,
        }));
        store = removeProgress(store, id);
        expect((store[STORAGE_KEY] || {})[id]).toBeUndefined();
        store = upsertProgress({}, buildProgressRecord({
            documentId: id,
            name: 'book.epub',
            size: 2,
            format: 'epub',
            chapterHref: 'a.xhtml',
            blockIndex: 1,
            chapterFingerprint: 'fp',
            revision: 1,
            updatedAt: 10,
        }));
        store = clearAllProgress(store);
        expect(store[STORAGE_KEY] || {}).toEqual({});
    });

    test('STORAGE_KEY stays in local storage namespace', () => {
        expect(STORAGE_KEY).toBe('readerProgressByDocumentId');
        expect(STORAGE_KEY).not.toMatch(/sync/i);
    });
});
