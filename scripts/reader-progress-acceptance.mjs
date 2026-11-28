/**
 * Shared helpers for #196 packaged-reader progress/bookmark acceptance.
 * Pure assertions only — browser automation lives in the Chromium/Firefox
 * live harnesses so Jest can fail-closed if wiring is dropped.
 */

export const READER_PROGRESS_ACCEPTANCE_STAGE =
    'offline-reader-progress-bookmarks-fencing';

/** DOM selectors the live harnesses must exercise for #196. */
export const READER_PROGRESS_ACCEPTANCE_SELECTORS = Object.freeze({
    addBookmark: '#addBookmark',
    bookmarkListItems: '#bookmarkList li',
    bookmarkGo: '#bookmarkList .bookmark-go',
    bookmarkRemove: '#bookmarkList .bookmark-remove',
    clearBookmarks: '#clearBookmarks',
    resumeBanner: '#resumeBanner',
    resumeReading: '#resumeReading',
    startOverReading: '#startOverReading',
    clearReadingProgress: '#clearReadingProgress',
    playerSeekFwd: '#seekFwd',
});

/**
 * Packaged Chromium/Firefox reader tabs expose LockManager. Fail closed when
 * a harness host claims to be a real reader but lacks exclusive locks.
 */
export function assertLockManagerAvailable(locks) {
    if (typeof locks?.request !== 'function') {
        throw new Error(
            'Packaged reader requires navigator.locks.request for progress mutations');
    }
    return true;
}

/** Bookmark go-to must never start audio without an explicit Play. */
export function assertBookmarkJumpDidNotAutoplay(pendingAutoplay) {
    if (pendingAutoplay === true) {
        throw new Error('Bookmark go-to must keep pendingAutoplay false');
    }
    return true;
}

/** Resume banner must appear when prior progress exists for the same file. */
export function assertResumeBannerVisible(hidden) {
    if (hidden) {
        throw new Error('Expected resume banner after reopening the same EPUB');
    }
    return true;
}

/** Fail closed when the restored highlight is not the saved nonzero block. */
export function assertHighlightedBlock(text, expectedSubstring) {
    const needle = String(expectedSubstring || '');
    if (!needle || !String(text || '').includes(needle)) {
        throw new Error(
            'Expected player highlight for saved block, got: ' +
            JSON.stringify({ text, expectedSubstring: needle }));
    }
    return true;
}

/**
 * Read the production bookmark storage shape: the key holds the array itself
 * (`planBookmarkAdd` writes `{ [readerBookmarks:id]: next }`), not `{bookmarks}`.
 */
export function bookmarkSnapshotFromStore(store, documentId) {
    const key = 'readerBookmarks:' + String(documentId || '');
    const list = Array.isArray(store?.[key]) ? store[key] : [];
    return {
        count: list.length,
        blockIndex: list[0]?.blockIndex ?? null,
        chapterHref: list[0]?.chapterHref ?? null,
    };
}

/**
 * Start over / clear must drop the prior saved position. A fresh block-0
 * save for the first chapter is allowed after the banner is dismissed.
 */
export function assertProgressClearedOrFirstChapter(record, firstHrefNeedle) {
    if (!record) return true;
    const href = String(record.chapterHref || '');
    const blockIndex = Number(record.blockIndex);
    const firstOk = firstHrefNeedle && href.includes(firstHrefNeedle) &&
        blockIndex === 0;
    if (firstOk) return true;
    throw new Error(
        'Expected progress cleared or first-chapter block 0 after start over: ' +
        JSON.stringify(record));
}

/**
 * Shape returned by live Chromium/Firefox progress stages so CI reports stay
 * comparable across browsers.
 */
export function buildProgressAcceptanceReport({
    locksAvailable,
    bookmarkAdded,
    bookmarkBlockIndex,
    bookmarkGoRestoredChapter,
    bookmarkGoRestoredBlock,
    bookmarkGoSuppressedAutoplay,
    bookmarkRemoved,
    staleProgressFenced,
    resumeBannerAfterReopen,
    resumeRestoredChapter,
    resumeRestoredBlock,
    resumePaused,
    progressClearedFromStorage,
    resumeCleared,
} = {}) {
    return {
        stage: READER_PROGRESS_ACCEPTANCE_STAGE,
        locksAvailable: Boolean(locksAvailable),
        bookmarkAdded: Boolean(bookmarkAdded),
        bookmarkBlockIndex: Number.isInteger(bookmarkBlockIndex)
            ? bookmarkBlockIndex : null,
        bookmarkGoRestoredChapter: bookmarkGoRestoredChapter || null,
        bookmarkGoRestoredBlock: Number.isInteger(bookmarkGoRestoredBlock)
            ? bookmarkGoRestoredBlock : null,
        bookmarkGoSuppressedAutoplay: Boolean(bookmarkGoSuppressedAutoplay),
        bookmarkRemoved: Boolean(bookmarkRemoved),
        staleProgressFenced: Boolean(staleProgressFenced),
        resumeBannerAfterReopen: Boolean(resumeBannerAfterReopen),
        resumeRestoredChapter: resumeRestoredChapter || null,
        resumeRestoredBlock: Number.isInteger(resumeRestoredBlock)
            ? resumeRestoredBlock : null,
        resumePaused: Boolean(resumePaused),
        progressClearedFromStorage: Boolean(progressClearedFromStorage),
        resumeCleared: Boolean(resumeCleared),
    };
}
