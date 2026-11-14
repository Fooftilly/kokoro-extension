/** @jest-environment node */
/**
 * Contract for dual-scope FastAPI preference honor (#61 / KE-29) — shape
 * distinct from fastapi-server-card and dual-use-this-backend (Sonar).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'fastapi-preference-honor-acceptance.mjs')).href;
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as honor from ${JSON.stringify(helperUrl)};
const apiUrl = 'http://127.0.0.1:9/v1/';
const report = honor.buildFastApiPreferenceHonorReport({
    browser: 'chromium', apiUrl, afterFastApiServerCard: true,
    articleBlockCount: 2, speechStubHits: 4,
});
honor.assertFastApiPreferenceHonorReport(report);
const html = honor.buildPreferenceHonorFixtureHtml();
const fail = (() => {
    try {
        honor.assertFastApiPreferenceHonorReport({ success: false });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    speech: honor.PREFERENCE_HONOR_SPEECH,
    htmlIncludes: html.includes(honor.PREFERENCE_HONOR_SPEECH.selection),
    report, fail,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('FastAPI preference-honor acceptance', () => {
    test('shared helper builds report and rejects bad shapes', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.speech.selection).toMatch(/FastAPI selection/i);
        expect(snap.htmlIncludes).toBe(true);
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            afterFastApiServerCard: true,
            selectedBackend: 'fastapi',
            noLocalWavFallback: true,
        }));
        expect(snap.report.selection.mpegDataUrl).toBe(true);
        expect(snap.report.article.mpegDataUrl).toBe(true);
        expect(snap.report.reader.mpegDataUrl).toBe(true);
        expect(snap.report.download.mp3Download).toBe(true);
        expect(snap.fail.ok).toBe(false);
        expect(snap.fail.message).toMatch(/not successful/i);
    });

    test('Chromium dual path wires preference honor after FastAPI card', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        const background = fs.readFileSync(
            path.join(root, 'background.js'), 'utf8');
        expect(source).toContain('fastapi-preference-honor-acceptance.mjs');
        expect(source).toContain('async function acceptFastApiPreferenceHonor');
        expect(source).toContain('waitForOverlayFastApiMpeg');
        expect(source).toContain('fastapiPreferenceHonorAcceptance');
        expect(source).toContain('mode: \'download\'');
        expect(source).toContain('fastapi-preference.txt');
        expect(source).toContain('data:audio');
        expect(source).toContain('__kokoroDownloadProbe');
        // Probe must not accept non-audio onCreated items (Devin #159).
        expect(source).toContain('if (!isFastApiDownloadItem(downloadHit))');
        expect(source).not.toContain(
            '!isFastApiDownloadItem(downloadHit) &&\n' +
            '            !downloadHit.id');
        expect(background).toContain('readAsDataURL(blob)');
        expect(background).toContain('await browser.downloads.download');
        const cardIdx = source.indexOf(
            'await acceptFastApiServerCard(');
        const honorIdx = source.indexOf(
            'await acceptFastApiPreferenceHonor(');
        expect(cardIdx).toBeGreaterThan(0);
        expect(honorIdx).toBeGreaterThan(cardIdx);
    });

    test('Firefox dual path wires preference honor after FastAPI card', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toContain('firefox_fastapi_preference_honor_acceptance');
        expect(source).toContain('def accept_fastapi_preference_honor');
        expect(source).toContain('_wait_overlay_fastapi_mpeg');
        expect(source).toContain('_OVERLAY_FASTAPI_MPEG_SCRIPT');
        expect(source).toContain('switch_to.frame');
        expect(source).toContain('_seed_firefox_fastapi_sync');
        expect(source).toContain('_honor_firefox_download');
        expect(source).toContain('fastapiPreferenceHonorAcceptance');
        expect(source).toContain('mode:\'download\'');
        // Download/reader storage must run on an extension page, not HTTP fixture.
        expect(source).toMatch(
            /_honor_firefox_download[\s\S]*?_on_extension_page\(/);
        expect(source).not.toMatch(
            /download_seed = driver\.execute_async_script/);
        const cardIdx = source.indexOf(
            'fastapi_card = accept_fastapi_server_card(');
        const honorIdx = source.indexOf(
            'fastapi_honor = accept_fastapi_preference_honor(');
        expect(cardIdx).toBeGreaterThan(0);
        expect(honorIdx).toBeGreaterThan(cardIdx);
    });
});
