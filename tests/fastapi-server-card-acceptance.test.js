/** @jest-environment node */
/**
 * Contract for dual-scope FastAPI server card (#61 / KE-27) — shape distinct
 * from dual-use-this-backend and popup-cta acceptance tests (Sonar).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'fastapi-server-card-acceptance.mjs')).href;
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as card from ${JSON.stringify(helperUrl)};
const apiUrl = 'http://127.0.0.1:9/v1/';
const report = card.buildFastApiServerCardReport({
    browser: 'chromium', apiUrl, afterLocalDualComparison: true,
    backendBeforeChoose: card.BACKEND_BEFORE_CHOOSE,
    chooseChangedBackend: true,
    decodeableMp3: true,
    audioDurationSec: 0.13,
});
card.assertFastApiServerCardReport(report);
const endpoint = card.speechEndpointFromApiUrl(apiUrl);
const fail = (() => {
    try {
        card.assertFastApiServerCardReport({ success: false });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    bytes: card.MINIMAL_MP3_BYTES.length,
    before: card.BACKEND_BEFORE_CHOOSE,
    needle: card.SERVER_PLAYABLE_MP3_NEEDLE,
    selected: card.FASTAPI_SELECTED_NEEDLE,
    endpoint, report, fail,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('FastAPI server-card acceptance', () => {
    test('shared helper builds report and rejects bad shapes', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.bytes).toBeGreaterThan(400);
        expect(snap.before).toBe('mediapipe');
        expect(snap.needle).toMatch(/playable MP3/i);
        expect(snap.selected).toBe('FastAPI selected.');
        expect(snap.endpoint).toContain('/v1/audio/speech');
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            serverCardTested: true,
            playableMp3Returned: true,
            decodeableMp3: true,
            backendBeforeChoose: 'mediapipe',
            chooseChangedBackend: true,
            selectedBackend: 'fastapi',
            preferenceOnlyOnChoose: true,
            afterLocalDualComparison: true,
        }));
        expect(snap.fail.ok).toBe(false);
        expect(snap.fail.message).toMatch(/not successful/i);
    });

    test('Chromium dual path wires FastAPI card after local dual', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toContain('fastapi-server-card-acceptance.mjs');
        expect(source).toContain('async function acceptFastApiServerCard');
        expect(source).toContain("locator('#testServer').click()");
        expect(source).toContain("locator('#chooseServer').click()");
        expect(source).toContain('SERVER_PLAYABLE_MP3_NEEDLE');
        expect(source).toContain('FASTAPI_SELECTED_NEEDLE');
        expect(source).toContain('BACKEND_BEFORE_CHOOSE');
        expect(source).toContain('HAVE_CURRENT_DATA');
        expect(source).toContain('fastapiServerCardAcceptance');
        const dualIdx = source.indexOf(
            'await acceptTwoBackendComparison(');
        const cardIdx = source.indexOf(
            'await acceptFastApiServerCard(');
        const playableIdx = source.indexOf('SERVER_PLAYABLE_MP3_NEEDLE');
        const seedBeforeChoose = source.indexOf(
            '}, BACKEND_BEFORE_CHOOSE);');
        expect(dualIdx).toBeGreaterThan(0);
        expect(cardIdx).toBeGreaterThan(dualIdx);
        expect(seedBeforeChoose).toBeGreaterThan(playableIdx);
    });

    test('Firefox dual path wires FastAPI card after local dual', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toContain('firefox_fastapi_server_card_acceptance');
        expect(source).toContain('def accept_fastapi_server_card');
        expect(source).toContain('_start_fastapi_speech_stub');
        expect(source).toContain('_minimal_mp3_fixture_bytes');
        expect(source).toContain('HAVE_CURRENT_DATA');
        expect(source).toMatch(
            /find_element\(\s*By\.ID,\s*["']testServer["']\s*\)\.click\(\)/);
        expect(source).toMatch(
            /find_element\(\s*By\.ID,\s*["']chooseServer["']\s*\)\.click\(\)/);
        expect(source).toContain('fastapiServerCardAcceptance');
        expect(source).toContain('backend_before_choose');
        const dualIdx = source.indexOf(
            'accept_two_backend_comparison(driver, state["origin"])');
        const cardIdx = source.indexOf(
            'fastapi_card = accept_fastapi_server_card(');
        expect(dualIdx).toBeGreaterThan(0);
        expect(cardIdx).toBeGreaterThan(dualIdx);
    });
});
