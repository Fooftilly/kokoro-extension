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
    progressStorageKey,
    upsertProgress,
    removeProgress,
    clearAllProgress,
    fingerprintChapterBlocks,
    readProgressRecord,
} from '../reader-progress.js';

function digest(hex = 'a'.repeat(64)) {
    return hex;
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

    test('planProgressUpsert migrates legacy-only siblings before dropping the map', () => {
        const idA = documentIdFromDigest('a'.repeat(64));
        const idB = documentIdFromDigest('b'.repeat(64));
        const recordA = buildProgressRecord({
            documentId: idA, name: 'a.epub', size: 1, format: 'epub',
            chapterHref: 'a.xhtml', blockIndex: 1, chapterFingerprint: 'fp',
            revision: 1, updatedAt: 1,
        });
        const recordB = buildProgressRecord({
            documentId: idB, name: 'b.epub', size: 1, format: 'epub',
            chapterHref: 'b.xhtml', blockIndex: 2, chapterFingerprint: 'fp',
            revision: 1, updatedAt: 2,
        });
        const updatedA = buildProgressRecord({
            ...recordA, blockIndex: 5, updatedAt: 3, revision: 2,
        });
        const store = { [STORAGE_KEY]: { [idA]: recordA, [idB]: recordB } };
        const plan = planProgressUpsert(store, updatedA);
        expect(plan.set[progressStorageKey(idA)]).toEqual(updatedA);
        expect(plan.set[progressStorageKey(idB)]).toEqual(recordB);
        expect(plan.remove).toContain(STORAGE_KEY);
        const after = { ...plan.set };
        expect(readProgressRecord(after, idB).blockIndex).toBe(2);
    });

    test('planProgressUpsert does not rewrite peers that already have per-doc keys', () => {
        const idA = documentIdFromDigest('a'.repeat(64));
        const idB = documentIdFromDigest('b'.repeat(64));
        const recordA = buildProgressRecord({
            documentId: idA, name: 'a.epub', size: 1, format: 'epub',
            chapterHref: 'a.xhtml', blockIndex: 1, chapterFingerprint: 'fp',
            revision: 1, updatedAt: 1,
        });
        const recordB = buildProgressRecord({
            documentId: idB, name: 'b.epub', size: 1, format: 'epub',
            chapterHref: 'b.xhtml', blockIndex: 2, chapterFingerprint: 'fp',
            revision: 1, updatedAt: 2,
        });
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
        const idA = documentIdFromDigest('a'.repeat(64));
        const idB = documentIdFromDigest('b'.repeat(64));
        const recordA1 = buildProgressRecord({
            documentId: idA, name: 'a.epub', size: 1, format: 'epub',
            chapterHref: 'a.xhtml', blockIndex: 1, chapterFingerprint: 'fp',
            revision: 1, updatedAt: 1,
        });
        const recordB2 = buildProgressRecord({
            documentId: idB, name: 'b.epub', size: 1, format: 'epub',
            chapterHref: 'b.xhtml', blockIndex: 2, chapterFingerprint: 'fp',
            revision: 1, updatedAt: 2,
        });
        const recordA5 = buildProgressRecord({
            ...recordA1, blockIndex: 5, updatedAt: 10, revision: 2,
        });
        const recordB7 = buildProgressRecord({
            ...recordB2, blockIndex: 7, updatedAt: 11, revision: 2,
        });
        const store = {
            [progressStorageKey(idA)]: recordA1,
            [progressStorageKey(idB)]: recordB2,
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

    test('planProgressRemove migrates leftover legacy docs when clearing one', () => {
        const idA = documentIdFromDigest('a'.repeat(64));
        const idB = documentIdFromDigest('b'.repeat(64));
        const recordA = buildProgressRecord({
            documentId: idA, name: 'a.epub', size: 1, format: 'epub',
            chapterHref: 'a.xhtml', blockIndex: 1, chapterFingerprint: 'fp',
            revision: 1, updatedAt: 1,
        });
        const recordB = buildProgressRecord({
            documentId: idB, name: 'b.epub', size: 1, format: 'epub',
            chapterHref: 'b.xhtml', blockIndex: 2, chapterFingerprint: 'fp',
            revision: 1, updatedAt: 2,
        });
        const store = { [STORAGE_KEY]: { [idA]: recordA, [idB]: recordB } };
        const plan = planProgressRemove(store, idA);
        expect(plan.remove).toEqual(expect.arrayContaining([
            progressStorageKey(idA), STORAGE_KEY,
        ]));
        expect(plan.set[progressStorageKey(idB)]).toEqual(recordB);
        expect(plan.set[progressStorageKey(idA)]).toBeUndefined();
        expect(readProgressRecord(plan.set, idB).blockIndex).toBe(2);
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
