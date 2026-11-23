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
});
