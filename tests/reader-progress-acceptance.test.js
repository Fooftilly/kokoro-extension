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
const readerSource = path.join(root, 'reader.js');

function stripJsComments(source) {
    return String(source || '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function stripPythonComments(source) {
    return String(source || '').replace(/(^|[^'"])#.*$/gm, '$1');
}

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
    bookmarkSnapshotFromStore,
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
const docId = 'sha256:' + 'a'.repeat(64);
const plannerShape = {
    ['readerBookmarks:' + docId]: [{
        id: 'bm_1', documentId: docId, label: 'Third · 2',
        chapterHref: 'third.xhtml', blockIndex: 1,
        chapterFingerprint: 'fp', createdAt: 1,
    }],
};
const nestedWrongShape = {
    ['readerBookmarks:' + docId]: { bookmarks: plannerShape['readerBookmarks:' + docId] },
};
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
    bookmarkSnapshot: bookmarkSnapshotFromStore(plannerShape, docId),
    nestedWrong: bookmarkSnapshotFromStore(nestedWrongShape, docId),
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
        expect(payload.bookmarkSnapshot).toEqual({
            count: 1, blockIndex: 1, chapterHref: 'third.xhtml',
        });
        expect(payload.nestedWrong).toEqual({
            count: 0, blockIndex: null, chapterHref: null,
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
        expect(source).toMatch(/priorRevision/);
        expect(source).toMatch(/waitForProgressRecord/);
        expect(source).toMatch(/bookmarkSnapshotFromStore/);
        expect(source).toMatch(/resumeThenStartOver/);
        expect(source).toMatch(/preview\.revision/);
        expect(source).toMatch(/pendingStartIndex/);
        expect(source).toMatch(/autoplayReader:\s*true/);
        expect(source).toMatch(/READER_ACCEPTANCE_THIRD_BLOCKS/);
        expect(source).toMatch(/__kokoroReadingProgressHandled/);
        expect(source).not.toMatch(/blockIndex:\s*99/);

        // Fail closed if acceptRealEpubReader drops the stage invocation.
        const entryStart = source.indexOf('async function acceptRealEpubReader(');
        expect(entryStart).toBeGreaterThanOrEqual(0);
        const nextFn = source.indexOf('\nasync function ', entryStart + 1);
        const entryBody = source.slice(
            entryStart, nextFn === -1 ? undefined : nextFn);
        const liveBody = stripJsComments(entryBody);
        expect(liveBody).toMatch(
            /const progressAcceptance = await acceptReaderProgressAndBookmarks\(/);
        expect(liveBody).toMatch(/progressAcceptance,/);

        const sabotaged = entryBody.replace(
            /const progressAcceptance = await acceptReaderProgressAndBookmarks\([\s\S]*?\);/,
            '// const progressAcceptance = await acceptReaderProgressAndBookmarks(...);\n' +
            '    const progressAcceptance = null;');
        const sabotagedLive = stripJsComments(sabotaged);
        expect(sabotagedLive).not.toMatch(
            /const progressAcceptance = await acceptReaderProgressAndBookmarks\(/);
        expect(sabotagedLive).toMatch(/progressAcceptance\s*=\s*null/);
    });

    test('Firefox live harness wires progress/bookmark acceptance stage', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
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
        expect(source).toMatch(/prior_revision/);
        expect(source).toMatch(/_wait_for_progress_record/);
        expect(source).toMatch(/bookmark_snapshot_from_store/);
        expect(source).toMatch(/_resume_then_start_over/);
        expect(source).toMatch(/preview\["revision"\]|preview\.get\("revision"\)/);
        expect(source).toMatch(/pendingStartIndex/);
        expect(source).toMatch(/autoplayReader/);
        expect(source).toMatch(/READER_ACCEPTANCE_THIRD_BLOCKS/);
        expect(source).toMatch(/__kokoroReadingProgressHandled/);
        expect(source).not.toMatch(/blockIndex:\s*99|blockIndex = 99/);

        // Fail closed if accept_real_epub_reader drops the stage invocation.
        const entryStart = source.indexOf('def accept_real_epub_reader(');
        expect(entryStart).toBeGreaterThanOrEqual(0);
        const nextDef = source.indexOf('\ndef ', entryStart + 1);
        const entryBody = source.slice(
            entryStart, nextDef === -1 ? undefined : nextDef);
        const liveBody = stripPythonComments(entryBody);
        expect(liveBody).toMatch(
            /progress_acceptance = accept_reader_progress_and_bookmarks\(/);
        expect(liveBody).toMatch(/"progressAcceptance": progress_acceptance/);

        const sabotaged = entryBody.replace(
            /progress_acceptance = accept_reader_progress_and_bookmarks\([\s\S]*?\)/,
            '# progress_acceptance = accept_reader_progress_and_bookmarks(...)\n' +
            '        progress_acceptance = None');
        const sabotagedLive = stripPythonComments(sabotaged);
        expect(sabotagedLive).not.toMatch(
            /progress_acceptance = accept_reader_progress_and_bookmarks\(/);
        expect(sabotagedLive).toMatch(/progress_acceptance = None/);
    });

    test('reader.js exposes progress-handled counter for fencing waits', () => {
        const source = fs.readFileSync(readerSource, 'utf8');
        expect(source).toMatch(/__kokoroReadingProgressHandled/);
        expect(source).toMatch(/KOKORO_READING_PROGRESS/);
    });
});
