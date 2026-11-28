/** @jest-environment node */
/**
 * #196 packaged-reader progress/bookmark acceptance contracts.
 * Live Chromium/Firefox harnesses must keep these stages wired; this suite
 * fails closed if the selectors/assertions are dropped from source.
 *
 * Shells out to Node ESM so CommonJS Jest does not re-embed the helper.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');
const helperModule = path.join(scriptsDir, 'reader-progress-acceptance.mjs');
const chromiumLive = path.join(scriptsDir, 'validate-live-chromium.mjs');
const firefoxLive = path.join(scriptsDir, 'validate-live-firefox.py');

function runHelperProbe(jsSnippet) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(helperModule)}).href);
const {
    assertLockManagerAvailable,
    assertBookmarkJumpDidNotAutoplay,
    assertHighlightedBlock,
    assertProgressClearedOrFirstChapter,
    assertResumeBannerVisible,
    buildProgressAcceptanceReport,
    READER_PROGRESS_ACCEPTANCE_STAGE,
} = mod;
${jsSnippet}
`], { encoding: 'utf8', cwd: root });
}

describe('reader progress packaged acceptance helpers (#196)', () => {
    test('LockManager and autoplay/resume assertions fail closed', () => {
        const result = runHelperProbe(`
const ok = {
    locks: assertLockManagerAvailable({ request: async () => {} }),
    noAutoplay: assertBookmarkJumpDidNotAutoplay(false),
    noAutoplayUndef: assertBookmarkJumpDidNotAutoplay(undefined),
    resume: assertResumeBannerVisible(false),
    highlight: assertHighlightedBlock(
        'Hello third chapter block two.', 'block two'),
    cleared: assertProgressClearedOrFirstChapter(null, 'first.xhtml'),
    firstBlock0: assertProgressClearedOrFirstChapter({
        chapterHref: 'OEBPS/first.xhtml', blockIndex: 0,
    }, 'first.xhtml'),
};
let failures = [];
try { assertLockManagerAvailable(null); failures.push('locks-accepted-null'); }
catch (error) { failures.push(String(error.message || error)); }
try { assertBookmarkJumpDidNotAutoplay(true); failures.push('autoplay-accepted'); }
catch (error) { failures.push(String(error.message || error)); }
try { assertResumeBannerVisible(true); failures.push('resume-accepted-hidden'); }
catch (error) { failures.push(String(error.message || error)); }
try {
    assertHighlightedBlock('Hello third chapter.', 'block two');
    failures.push('highlight-accepted-wrong');
} catch (error) { failures.push(String(error.message || error)); }
try {
    assertProgressClearedOrFirstChapter({
        chapterHref: 'third.xhtml', blockIndex: 1,
    }, 'first.xhtml');
    failures.push('clear-accepted-stale');
} catch (error) { failures.push(String(error.message || error)); }
const report = buildProgressAcceptanceReport({
    locksAvailable: true,
    bookmarkAdded: true,
    bookmarkBlockIndex: 1,
    bookmarkGoRestoredChapter: 'Third Chapter',
    bookmarkGoRestoredBlock: 1,
    bookmarkGoSuppressedAutoplay: true,
    bookmarkRemoved: true,
    staleProgressFenced: true,
    resumeBannerAfterReopen: true,
    resumeRestoredChapter: 'Third Chapter',
    resumeRestoredBlock: 1,
    resumePaused: true,
    progressClearedFromStorage: true,
    resumeCleared: true,
});
process.stdout.write(JSON.stringify({
    ok, failures, report, stage: READER_PROGRESS_ACCEPTANCE_STAGE,
}));
`);
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const payload = JSON.parse(result.stdout);
        expect(payload.ok).toEqual({
            locks: true,
            noAutoplay: true,
            noAutoplayUndef: true,
            resume: true,
            highlight: true,
            cleared: true,
            firstBlock0: true,
        });
        expect(payload.failures).toEqual(expect.arrayContaining([
            expect.stringMatching(/locks\.request/),
            expect.stringMatching(/pendingAutoplay/),
            expect.stringMatching(/resume banner/),
            expect.stringMatching(/highlight/),
            expect.stringMatching(/first-chapter block 0/),
        ]));
        expect(payload.failures).toHaveLength(5);
        expect(payload.report).toEqual(expect.objectContaining({
            stage: payload.stage,
            locksAvailable: true,
            bookmarkBlockIndex: 1,
            bookmarkGoRestoredBlock: 1,
            staleProgressFenced: true,
            resumeRestoredBlock: 1,
            progressClearedFromStorage: true,
        }));
    });

    test('Chromium live harness wires progress/bookmark acceptance stage', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toMatch(/reader-progress-acceptance\.mjs/);
        expect(source).toMatch(/acceptReaderProgressAndBookmarks/);
        expect(source).toMatch(/assertLockManagerAvailable/);
        expect(source).toMatch(/assertBookmarkJumpDidNotAutoplay/);
        expect(source).toMatch(/assertResumeBannerVisible/);
        expect(source).toMatch(/assertHighlightedBlock/);
        expect(source).toMatch(/assertProgressClearedOrFirstChapter/);
        expect(source).toMatch(/#addBookmark/);
        expect(source).toMatch(/#bookmarkList/);
        expect(source).toMatch(/#seekFwd/);
        expect(source).toMatch(/resumeBanner/);
        expect(source).toMatch(/#resumeReading/);
        expect(source).toMatch(/#startOverReading/);
        expect(source).toMatch(/KOKORO_READING_PROGRESS/);
        expect(source).toMatch(/staleProgressFenced/);
        expect(source).toMatch(/autoplayReader:\s*true/);
        expect(source).toMatch(/progressAcceptance/);
        expect(source).toMatch(/Hello third chapter block two/);
    });

    test('Firefox live harness wires progress/bookmark acceptance stage', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toMatch(/accept_reader_progress_and_bookmarks/);
        expect(source).toMatch(/assert_lock_manager_available/);
        expect(source).toMatch(/assert_highlighted_block/);
        expect(source).toMatch(/assert_progress_cleared_or_first_chapter/);
        expect(source).toMatch(/addBookmark/);
        expect(source).toMatch(/bookmarkList/);
        expect(source).toMatch(/seekFwd/);
        expect(source).toMatch(/resumeBanner/);
        expect(source).toMatch(/resumeReading/);
        expect(source).toMatch(/startOverReading/);
        expect(source).toMatch(/KOKORO_READING_PROGRESS/);
        expect(source).toMatch(/stale_progress_fenced/);
        expect(source).toMatch(/autoplayReader/);
        expect(source).toMatch(/progressAcceptance/);
        expect(source).toMatch(/Hello third chapter block two/);
    });
});
