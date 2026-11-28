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
};
let failures = [];
try { assertLockManagerAvailable(null); failures.push('locks-accepted-null'); }
catch (error) { failures.push(String(error.message || error)); }
try { assertBookmarkJumpDidNotAutoplay(true); failures.push('autoplay-accepted'); }
catch (error) { failures.push(String(error.message || error)); }
try { assertResumeBannerVisible(true); failures.push('resume-accepted-hidden'); }
catch (error) { failures.push(String(error.message || error)); }
const report = buildProgressAcceptanceReport({
    locksAvailable: true,
    bookmarkAdded: true,
    bookmarkGoRestoredChapter: 'Third Chapter',
    bookmarkGoSuppressedAutoplay: true,
    bookmarkRemoved: true,
    resumeBannerAfterReopen: true,
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
        });
        expect(payload.failures).toEqual(expect.arrayContaining([
            expect.stringMatching(/locks\.request/),
            expect.stringMatching(/pendingAutoplay/),
            expect.stringMatching(/resume banner/),
        ]));
        expect(payload.failures).toHaveLength(3);
        expect(payload.report).toEqual(expect.objectContaining({
            stage: payload.stage,
            locksAvailable: true,
            bookmarkGoRestoredChapter: 'Third Chapter',
            bookmarkRemoved: true,
        }));
    });

    test('Chromium live harness wires progress/bookmark acceptance stage', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toMatch(/reader-progress-acceptance\.mjs/);
        expect(source).toMatch(/acceptReaderProgressAndBookmarks/);
        expect(source).toMatch(/assertLockManagerAvailable/);
        expect(source).toMatch(/assertBookmarkJumpDidNotAutoplay/);
        expect(source).toMatch(/assertResumeBannerVisible/);
        expect(source).toMatch(/#addBookmark/);
        expect(source).toMatch(/#bookmarkList/);
        // Chromium waits via getElementById('resumeBanner'); keep both shapes.
        expect(source).toMatch(/resumeBanner/);
        expect(source).toMatch(/#startOverReading/);
        expect(source).toMatch(/progressAcceptance/);
    });

    test('Firefox live harness wires progress/bookmark acceptance stage', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toMatch(/accept_reader_progress_and_bookmarks/);
        expect(source).toMatch(/assert_lock_manager_available/);
        expect(source).toMatch(/addBookmark/);
        expect(source).toMatch(/bookmarkList/);
        expect(source).toMatch(/resumeBanner/);
        expect(source).toMatch(/startOverReading/);
        expect(source).toMatch(/progressAcceptance/);
    });
});
