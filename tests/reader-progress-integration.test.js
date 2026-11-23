/**
 * @jest-environment jsdom
 *
 * Integration coverage for #196 first slice: save/restore fencing and removal
 * via the pure progress helpers + storage.local shape used by reader.js.
 */
import { webcrypto } from 'crypto';
import { TextEncoder } from 'util';
import {
    STORAGE_KEY,
    documentIdFromDigest,
    hexDigestFromBuffer,
    fingerprintChapterBlocks,
    buildProgressRecord,
    shouldAcceptProgressWrite,
    shouldPersistProgressUpdate,
    resolveResumeTarget,
    upsertProgress,
    planProgressRemove,
    progressStorageKey,
    readProgressRecord,
} from '../reader-progress.js';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('reader progress persistence integration (#196)', () => {
    test('same bytes resume; different bytes with same name do not', async () => {
        const a = new TextEncoder().encode('document-a-bytes').buffer;
        const b = new TextEncoder().encode('document-b-bytes').buffer;
        const idA = documentIdFromDigest(await hexDigestFromBuffer(a));
        const idB = documentIdFromDigest(await hexDigestFromBuffer(b));
        expect(idA).not.toBe(idB);

        const blocks = [
            { content: 'One.', ids: [] },
            { content: 'Two.', ids: [] },
            { content: 'Three.', ids: [] },
        ];
        const fp = fingerprintChapterBlocks(blocks);
        let store = upsertProgress({}, buildProgressRecord({
            documentId: idA,
            name: 'same-name.epub',
            size: a.byteLength,
            format: 'epub',
            chapterHref: 'ch.xhtml',
            blockIndex: 2,
            chapterFingerprint: fp,
            revision: 1,
            updatedAt: 10,
        }));

        expect(readProgressRecord(store, idA).blockIndex).toBe(2);
        expect(readProgressRecord(store, idB)).toBeNull();

        const ok = resolveResumeTarget({
            record: readProgressRecord(store, idA),
            flatToc: [{ href: 'ch.xhtml', label: 'Chapter' }],
            chapterFingerprint: fp,
            chapterBlockCount: 3,
        });
        expect(ok).toEqual(expect.objectContaining({ ok: true, blockIndex: 2 }));

        const wrongFile = resolveResumeTarget({
            record: readProgressRecord(store, idA),
            flatToc: [{ href: 'ch.xhtml', label: 'Chapter' }],
            chapterFingerprint: fingerprintChapterBlocks([
                { content: 'Different chapter text.', ids: [] },
            ]),
            chapterBlockCount: 1,
        });
        expect(wrongFile.ok).toBe(false);
    });

    test('stale chapter revision writes are rejected before storage update', () => {
        expect(shouldAcceptProgressWrite({
            writeRevision: 1,
            currentRevision: 2,
            writeChapterRequestId: 1,
            currentChapterRequestId: 1,
            writeDocumentId: 'sha256:' + 'a'.repeat(64),
            currentDocumentId: 'sha256:' + 'a'.repeat(64),
        })).toBe(false);
    });

    test('resume decision pending prevents progress overwrite with block 0', () => {
        expect(shouldPersistProgressUpdate({ resumeDecisionPending: true })).toBe(false);
        const id = documentIdFromDigest('b'.repeat(64));
        const blocks = [
            { content: 'One.', ids: [] },
            { content: 'Two.', ids: [] },
            { content: 'Three.', ids: [] },
        ];
        const saved = buildProgressRecord({
            documentId: id,
            name: 'book.epub',
            size: 10,
            format: 'epub',
            chapterHref: 'ch.xhtml',
            blockIndex: 2,
            chapterFingerprint: fingerprintChapterBlocks(blocks),
            revision: 1,
            updatedAt: 5,
        });
        // Simulated overlay init at block 0 must not replace the saved record
        // while the resume banner is showing.
        if (shouldPersistProgressUpdate({ resumeDecisionPending: true })) {
            throw new Error('must not persist during resume decision');
        }
        expect(saved.blockIndex).toBe(2);
        expect(resolveResumeTarget({
            record: saved,
            flatToc: [{ href: 'ch.xhtml', label: 'Ch' }],
            chapterFingerprint: fingerprintChapterBlocks(blocks),
            chapterBlockCount: blocks.length,
        }).ok).toBe(true);
    });

    test('clear removes only the selected document progress', async () => {
        const idKeep = documentIdFromDigest(await hexDigestFromBuffer(
            new TextEncoder().encode('keep').buffer));
        const idDrop = documentIdFromDigest(await hexDigestFromBuffer(
            new TextEncoder().encode('drop').buffer));
        const keep = buildProgressRecord({
            documentId: idKeep, name: 'keep.epub', size: 1, format: 'epub',
            chapterHref: 'a.xhtml', blockIndex: 0, chapterFingerprint: 'fp',
            revision: 1, updatedAt: 1,
        });
        const drop = buildProgressRecord({
            documentId: idDrop, name: 'drop.epub', size: 1, format: 'epub',
            chapterHref: 'a.xhtml', blockIndex: 1, chapterFingerprint: 'fp',
            revision: 1, updatedAt: 2,
        });
        // Production path: plan against a store that still holds both records.
        const store = { [STORAGE_KEY]: { [idKeep]: keep, [idDrop]: drop } };
        const plan = planProgressRemove(store, idDrop);
        expect(plan.remove).toEqual([progressStorageKey(idDrop)]);
        expect(plan.set[STORAGE_KEY]).toEqual({ [idKeep]: keep });
        expect(plan.set[progressStorageKey(idKeep)]).toBeUndefined();
        const applied = { ...store, ...plan.set };
        for (const key of plan.remove) delete applied[key];
        expect(readProgressRecord(applied, idKeep)).toEqual(keep);
        expect(readProgressRecord(applied, idDrop)).toBeNull();
    });
});
