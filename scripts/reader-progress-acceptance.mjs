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

/**
 * Shape returned by live Chromium/Firefox progress stages so CI reports stay
 * comparable across browsers.
 */
export function buildProgressAcceptanceReport({
    locksAvailable,
    bookmarkAdded,
    bookmarkGoRestoredChapter,
    bookmarkGoSuppressedAutoplay,
    bookmarkRemoved,
    resumeBannerAfterReopen,
    resumeCleared,
} = {}) {
    return {
        stage: READER_PROGRESS_ACCEPTANCE_STAGE,
        locksAvailable: Boolean(locksAvailable),
        bookmarkAdded: Boolean(bookmarkAdded),
        bookmarkGoRestoredChapter: bookmarkGoRestoredChapter || null,
        bookmarkGoSuppressedAutoplay: Boolean(bookmarkGoSuppressedAutoplay),
        bookmarkRemoved: Boolean(bookmarkRemoved),
        resumeBannerAfterReopen: Boolean(resumeBannerAfterReopen),
        resumeCleared: Boolean(resumeCleared),
    };
}
