/**
 * @jest-environment jsdom
 */

import {
    documentIdFromDigest,
    buildBookmarkRecord,
    readBookmarks,
    planBookmarkAdd,
    planBookmarkRemove,
    planBookmarkClear,
    resolveBookmarkTarget,
    findBookmarkTocItem,
    prepareBookmarkForCurrentToc,
    resolveBookmarkHeadingForBlock,
    resolveBookmarkPlayback,
    resolveBookmarkJump,
    isSameBookmarkPosition,
    shouldAcceptReadingProgress,
    bookmarkStorageKey,
    MAX_BOOKMARKS_PER_DOCUMENT,
    fingerprintChapterBlocks,
} from '../reader-progress.js';

describe('reader bookmarks helpers (#196)', () => {
    const id = documentIdFromDigest('a'.repeat(64));

    function bookmark(overrides = {}) {
        return buildBookmarkRecord({
            id: 'bm_1',
            documentId: id,
            label: 'Chapter · 2',
            chapterHref: 'a.xhtml',
            blockIndex: 1,
            chapterFingerprint: 'fp',
            createdAt: 10,
            ...overrides,
        });
    }

    test('planBookmarkAdd prepends, dedupes same position, and bounds the list', () => {
        let store = {};
        for (let i = 0; i < MAX_BOOKMARKS_PER_DOCUMENT + 3; i++) {
            const plan = planBookmarkAdd(store, bookmark({
                id: `bm_${i}`,
                blockIndex: i,
                createdAt: i + 1,
            }));
            store = { ...store, ...plan.set };
        }
        const list = readBookmarks(store, id);
        expect(list).toHaveLength(MAX_BOOKMARKS_PER_DOCUMENT);
        expect(list[0].blockIndex).toBe(MAX_BOOKMARKS_PER_DOCUMENT + 2);

        const dup = planBookmarkAdd(store, bookmark({
            id: 'bm_dup',
            blockIndex: list[0].blockIndex,
            createdAt: 999,
            label: 'Updated',
        }));
        const afterDup = { ...store, ...dup.set };
        const samePos = readBookmarks(afterDup, id)
            .filter((entry) => entry.blockIndex === list[0].blockIndex);
        expect(samePos).toHaveLength(1);
        expect(samePos[0].label).toBe('Updated');
    });

    test('planBookmarkAdd dedupes spine path after TOC fragment remap', () => {
        const first = bookmark({
            id: 'bm_file',
            chapterHref: 'chapter.xhtml',
            blockIndex: 12,
            chapterFingerprint: 'fp-same',
            createdAt: 1,
        });
        const remapped = bookmark({
            id: 'bm_heading',
            chapterHref: 'chapter.xhtml#methods',
            blockIndex: 12,
            chapterFingerprint: 'fp-same',
            createdAt: 2,
            label: 'Methods · 13',
        });
        expect(isSameBookmarkPosition(first, remapped)).toBe(true);
        let store = {};
        store = { ...store, ...planBookmarkAdd(store, first).set };
        store = { ...store, ...planBookmarkAdd(store, remapped).set };
        const list = readBookmarks(store, id);
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(expect.objectContaining({
            id: 'bm_heading',
            chapterHref: 'chapter.xhtml#methods',
            blockIndex: 12,
        }));
    });

    test('planBookmarkRemove and clear drop bookmarks without touching progress keys', () => {
        const first = bookmark({ id: 'bm_a', blockIndex: 0, createdAt: 1 });
        const second = bookmark({ id: 'bm_b', blockIndex: 2, createdAt: 2 });
        let store = {};
        store = { ...store, ...planBookmarkAdd(store, first).set };
        store = { ...store, ...planBookmarkAdd(store, second).set };
        expect(readBookmarks(store, id)).toHaveLength(2);

        const removePlan = planBookmarkRemove(store, id, 'bm_a');
        store = { ...store, ...removePlan.set };
        for (const key of removePlan.remove) delete store[key];
        expect(readBookmarks(store, id).map((entry) => entry.id)).toEqual(['bm_b']);

        const clearPlan = planBookmarkClear(store, id);
        expect(clearPlan.remove).toEqual([bookmarkStorageKey(id)]);
        for (const key of clearPlan.remove) delete store[key];
        expect(readBookmarks(store, id)).toEqual([]);
    });

    test('resolveBookmarkTarget validates fingerprint and block range', () => {
        const blocks = [
            { content: 'One.', ids: [] },
            { content: 'Two.', ids: [] },
        ];
        const fp = fingerprintChapterBlocks(blocks);
        const record = bookmark({
            chapterFingerprint: fp,
            blockIndex: 1,
            chapterHref: 'a.xhtml',
        });
        expect(resolveBookmarkTarget({
            bookmark: record,
            flatToc: [{ href: 'a.xhtml', label: 'A' }],
            chapterFingerprint: fp,
            chapterBlockCount: 2,
        })).toEqual(expect.objectContaining({
            ok: true,
            blockIndex: 1,
            chapterHref: 'a.xhtml',
        }));
        expect(resolveBookmarkTarget({
            bookmark: record,
            flatToc: [{ href: 'a.xhtml', label: 'A' }],
            chapterFingerprint: 'changed',
            chapterBlockCount: 2,
        }).ok).toBe(false);
    });

    test('findBookmarkTocItem falls back to spine path when fragment TOC differs', () => {
        const toc = [
            { href: 'ch1.xhtml', label: 'Chapter 1' },
            { href: 'ch2.xhtml', label: 'Chapter 2' },
        ];
        expect(findBookmarkTocItem(toc, 'ch1.xhtml#scan-only').href).toBe('ch1.xhtml');
        expect(findBookmarkTocItem(toc, 'missing.xhtml')).toBeNull();
        expect(findBookmarkTocItem(toc, 'ch2.xhtml').href).toBe('ch2.xhtml');
    });

    test('fragment bookmark restores block after publisher TOC rewrite', () => {
        const blocks = Array.from({ length: 6 }, (_, i) => ({
            content: `Block ${i}.`, ids: [],
        }));
        const fp = fingerprintChapterBlocks(blocks);
        const saved = bookmark({
            chapterHref: 'ch1.xhtml#part2',
            blockIndex: 4,
            chapterFingerprint: fp,
        });
        const publisherToc = [{ href: 'ch1.xhtml', label: 'Chapter 1' }];
        const { item, record } = prepareBookmarkForCurrentToc(saved, publisherToc);
        expect(item.href).toBe('ch1.xhtml');
        expect(record.chapterHref).toBe('ch1.xhtml');
        expect(resolveBookmarkPlayback({
            bookmark: record,
            flatToc: publisherToc,
            chapterFingerprint: fp,
            chapterBlockCount: blocks.length,
        })).toEqual({
            startIndex: 4,
            suppressAutoplay: true,
            outdated: false,
            label: 'Chapter 1',
        });
    });

    test('publisher bookmark remaps to owning scanned heading without autoplay', () => {
        const blocks = [
            { content: 'Intro.', ids: ['part1'] },
            { content: 'A.', ids: [] },
            { content: 'Part two.', ids: ['part2'] },
            { content: 'B.', ids: [] },
            { content: 'C.', ids: [] },
        ];
        const fp = fingerprintChapterBlocks(blocks);
        const saved = bookmark({
            chapterHref: 'ch1.xhtml',
            blockIndex: 3,
            chapterFingerprint: fp,
        });
        const scannedToc = [
            { href: 'ch1.xhtml#part1', label: 'Part 1' },
            { href: 'ch1.xhtml#part2', label: 'Part 2' },
        ];
        expect(resolveBookmarkHeadingForBlock({
            flatToc: scannedToc,
            blocks,
            blockIndex: 3,
            fallbackItem: scannedToc[0],
        }).href).toBe('ch1.xhtml#part2');
        const jump = resolveBookmarkJump({
            bookmark: saved,
            flatToc: scannedToc,
            blocks,
            chapterFingerprint: fp,
        });
        expect(jump).toEqual(expect.objectContaining({
            startIndex: 3,
            suppressAutoplay: true,
            outdated: false,
            label: 'Part 2',
            item: expect.objectContaining({
                href: 'ch1.xhtml#part2',
                label: 'Part 2',
            }),
        }));
        expect(jump.record.chapterHref).toBe('ch1.xhtml#part2');
        // Player title must use the remapped heading label (not Part 1).
        expect(jump.item.label).toBe('Part 2');
    });

    test('shouldAcceptReadingProgress requires the acknowledged current revision', () => {
        expect(shouldAcceptReadingProgress({
            messageRevision: 3,
            renderedChapterRevision: 3,
            renderedChapterRequestId: 7,
            chapterRequestId: 7,
        })).toBe(true);
        expect(shouldAcceptReadingProgress({
            messageRevision: 2,
            renderedChapterRevision: 3,
            renderedChapterRequestId: 7,
            chapterRequestId: 7,
        })).toBe(false);
        expect(shouldAcceptReadingProgress({
            messageRevision: 3,
            renderedChapterRevision: 3,
            renderedChapterRequestId: 6,
            chapterRequestId: 7,
        })).toBe(false);
        expect(shouldAcceptReadingProgress({
            messageRevision: undefined,
            renderedChapterRevision: 3,
            renderedChapterRequestId: 7,
            chapterRequestId: 7,
        })).toBe(false);
    });

    test('resolveBookmarkPlayback seeks saved block without autoplay', () => {
        const blocks = [
            { content: 'One.', ids: [] },
            { content: 'Two.', ids: [] },
            { content: 'Three.', ids: [] },
        ];
        const fp = fingerprintChapterBlocks(blocks);
        const record = bookmark({
            chapterFingerprint: fp,
            blockIndex: 2,
            chapterHref: 'a.xhtml',
        });
        expect(resolveBookmarkPlayback({
            bookmark: record,
            flatToc: [{ href: 'a.xhtml', label: 'A' }],
            chapterFingerprint: fp,
            chapterBlockCount: 3,
        })).toEqual({
            startIndex: 2,
            suppressAutoplay: true,
            outdated: false,
            label: 'A',
        });
        expect(resolveBookmarkPlayback({
            bookmark: record,
            flatToc: [{ href: 'a.xhtml', label: 'A' }],
            chapterFingerprint: 'stale',
            chapterBlockCount: 3,
        })).toEqual({
            startIndex: 0,
            suppressAutoplay: true,
            outdated: true,
            label: null,
        });
    });
});
