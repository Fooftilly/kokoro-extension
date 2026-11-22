/** @jest-environment node */
/**
 * Contract for dual-scope FastAPI server card
 * (#61 / KE-27 + KE-34 TTFB + KE-40 playback-start + KE-41c MediaSource honesty).
 * Shape distinct from dual-use-this-backend and popup-cta (Sonar).
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
const split = card.splitFastApiStubMp3ForProgressive(card.MINIMAL_MP3_BYTES);
const expectedTail = Math.min(
    Math.max(
        card.FASTAPI_STUB_PROGRESSIVE_TAIL_BYTES,
        Math.floor(card.MINIMAL_MP3_BYTES.byteLength *
            card.FASTAPI_STUB_PROGRESSIVE_TAIL_RATIO)),
    card.MINIMAL_MP3_BYTES.byteLength - 1);
const splitOk = split.first.byteLength + split.rest.byteLength ===
    card.MINIMAL_MP3_BYTES.byteLength &&
    split.rest.byteLength === expectedTail &&
    card.MINIMAL_MP3_BYTES.byteLength > 8000 &&
    card.FASTAPI_STUB_FIRST_BYTE_DELAY_MS === 100 &&
    card.FASTAPI_STUB_PROGRESSIVE_TAIL_HOLD_MS === 2000;
const apiUrl = 'http://127.0.0.1:9/v1/';
const report = card.buildFastApiServerCardReport({
    browser: 'chromium', apiUrl, afterLocalDualComparison: true,
    backendBeforeChoose: card.BACKEND_BEFORE_CHOOSE,
    chooseChangedBackend: true,
    decodeableMp3: true,
    audioDurationSec: 0.13,
    streamingFirstBodyByteMeasured: true,
    playbackStartMeasured: true,
    mediasourceProgressiveTtfaMeasured: false,
    mediasourceProgressiveTtfaNotMeasured: true,
    firstBodyByteP50Ms: 110,
    synthesisP50Ms: 160,
    playbackStartP50Ms: 200,
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
const failTtfb = (() => {
    try {
        card.assertFastApiServerCardReport({
            ...report, streamingFirstBodyByteMeasured: false,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failBuffered = (() => {
    try {
        card.assertFastApiServerCardReport({
            ...report, firstBodyByteP50Ms: 120, synthesisP50Ms: 120,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failPlayback = (() => {
    try {
        card.assertFastApiServerCardReport({
            ...report, playbackStartP50Ms: 100,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failMediaSourceIncomplete = (() => {
    try {
        // measured=true without finite p50 / usedMediaSource must fail closed.
        card.assertFastApiServerCardReport({
            ...report, mediasourceProgressiveTtfaMeasured: true,
            mediasourceProgressiveTtfaNotMeasured: false,
            mediasourceProgressiveTtfaDisclosure:
                card.SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_MEASURED_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const measuredOk = card.buildFastApiServerCardReport({
    browser: 'chromium', apiUrl, afterLocalDualComparison: true,
    backendBeforeChoose: card.BACKEND_BEFORE_CHOOSE,
    chooseChangedBackend: true,
    decodeableMp3: true,
    audioDurationSec: 0.13,
    streamingFirstBodyByteMeasured: true,
    playbackStartMeasured: true,
    firstBodyByteP50Ms: 110,
    synthesisP50Ms: 160,
    playbackStartP50Ms: 200,
    mediasourceProgressiveTtfaMeasured: true,
    mediasourceProgressiveTtfaNotMeasured: false,
    mediasourceProgressiveTtfaUnavailable: false,
    mediasourceProgressiveTtfaP50Ms: 240,
    usedMediaSource: true,
    mediasourceProgressiveTtfaDisclosure:
        card.SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_MEASURED_NEEDLE,
});
const failMediaSourceOmitted = (() => {
    try {
        // Live omit path: observed null/empty must fail closed (no invent).
        card.assertFastApiServerCardReport({
            ...report,
            mediasourceProgressiveTtfaMeasured: null,
            mediasourceProgressiveTtfaNotMeasured: false,
            mediasourceProgressiveTtfaDisclosure: '',
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
// buildFastApiServerCardReport asserts inline — live omit must throw there.
const failOmitBuild = (() => {
    try {
        card.buildFastApiServerCardReport({
            browser: 'chromium', apiUrl, afterLocalDualComparison: true,
            backendBeforeChoose: card.BACKEND_BEFORE_CHOOSE,
            chooseChangedBackend: true,
            decodeableMp3: true,
            audioDurationSec: 0.13,
            streamingFirstBodyByteMeasured: true,
            playbackStartMeasured: true,
            firstBodyByteP50Ms: 110,
            synthesisP50Ms: 160,
            playbackStartP50Ms: 200,
            mediasourceProgressiveTtfaMeasured: null,
            mediasourceProgressiveTtfaNotMeasured: false,
            mediasourceProgressiveTtfaDisclosure: '',
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    bytes: card.MINIMAL_MP3_BYTES.length,
    splitOk,
    before: card.BACKEND_BEFORE_CHOOSE,
    needle: card.SERVER_PLAYABLE_MP3_NEEDLE,
    ttfbNeedle: card.SERVER_FIRST_BODY_BYTE_NEEDLE,
    playbackNeedle: card.SERVER_PLAYBACK_START_NEEDLE,
    notMediaSource: card.SERVER_NOT_MEDIASOURCE_NEEDLE,
    mediaSourceNotMeasured:
        card.SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE,
    mediaSourceMeasured:
        card.SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_MEASURED_NEEDLE,
    selected: card.FASTAPI_SELECTED_NEEDLE,
    endpoint, report, measuredOk, fail, failTtfb, failBuffered, failPlayback,
    failMediaSourceIncomplete, failMediaSourceOmitted, failOmitBuild,
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
        expect(snap.splitOk).toBe(true);
        expect(snap.before).toBe('mediapipe');
        expect(snap.needle).toMatch(/playable MP3/i);
        expect(snap.ttfbNeedle).toMatch(/First body byte \(TTFB\) p50/i);
        expect(snap.playbackNeedle).toMatch(/playback start p50/i);
        expect(snap.notMediaSource).toMatch(/not MediaSource streaming TTFA/i);
        expect(snap.mediaSourceNotMeasured).toMatch(
            /MediaSource progressive TTFA not measured/i);
        expect(snap.mediaSourceMeasured).toMatch(
            /progressive MediaSource TTFA measured/i);
        expect(snap.selected).toBe('FastAPI selected.');
        expect(snap.endpoint).toContain('/v1/audio/speech');
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            serverCardTested: true,
            playableMp3Returned: true,
            decodeableMp3: true,
            streamingFirstBodyByteMeasured: true,
            playbackStartMeasured: true,
            playbackStartNotMeasured: false,
            mediasourceProgressiveTtfaMeasured: false,
            mediasourceProgressiveTtfaNotMeasured: true,
            mediasourceProgressiveTtfaDisclosure:
                'MediaSource progressive TTFA not measured',
            firstBodyByteP50Ms: 110,
            synthesisP50Ms: 160,
            playbackStartP50Ms: 200,
            backendBeforeChoose: 'mediapipe',
            chooseChangedBackend: true,
            selectedBackend: 'fastapi',
            preferenceOnlyOnChoose: true,
            afterLocalDualComparison: true,
        }));
        expect(snap.measuredOk).toEqual(expect.objectContaining({
            mediasourceProgressiveTtfaMeasured: true,
            mediasourceProgressiveTtfaNotMeasured: false,
            mediasourceProgressiveTtfaP50Ms: 240,
            usedMediaSource: true,
        }));
        expect(snap.fail.ok).toBe(false);
        expect(snap.fail.message).toMatch(/not successful/i);
        expect(snap.failTtfb.ok).toBe(false);
        expect(snap.failTtfb.message).toMatch(/streamingFirstBodyByteMeasured/i);
        expect(snap.failBuffered.ok).toBe(false);
        expect(snap.failBuffered.message).toMatch(/strictly greater/i);
        expect(snap.failPlayback.ok).toBe(false);
        expect(snap.failPlayback.message).toMatch(/playbackStartP50Ms/i);
        expect(snap.failMediaSourceIncomplete.ok).toBe(false);
        expect(snap.failMediaSourceIncomplete.message).toMatch(
            /mediasourceProgressiveTtfaP50Ms|usedMediaSource/i);
        expect(snap.failMediaSourceOmitted.ok).toBe(false);
        expect(snap.failMediaSourceOmitted.message).toMatch(
            /mediasourceProgressiveTtfa/i);
        expect(snap.failOmitBuild.ok).toBe(false);
        expect(snap.failOmitBuild.message).toMatch(
            /mediasourceProgressiveTtfa/i);
    });

    test('Chromium dual path wires FastAPI card after local dual', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toContain('fastapi-server-card-acceptance.mjs');
        expect(source).toContain('async function acceptFastApiServerCard');
        expect(source).toContain("locator('#testServer').click()");
        expect(source).toContain("locator('#chooseServer').click()");
        expect(source).toContain('SERVER_PLAYABLE_MP3_NEEDLE');
        expect(source).toContain('SERVER_FIRST_BODY_BYTE_NEEDLE');
        expect(source).toContain('SERVER_PLAYBACK_START_NEEDLE');
        expect(source).toContain('SERVER_NOT_MEDIASOURCE_NEEDLE');
        expect(source).toContain(
            'SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE');
        expect(source).toContain(
            'SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_MEASURED_NEEDLE');
        expect(source).toContain(
            'SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_UNAVAILABLE_NEEDLE');
        expect(source).toContain('streamingFirstBodyByteMeasured');
        expect(source).toContain('playbackStartMeasured');
        expect(source).toContain('playbackStartP50Ms');
        // Live observes measured OR unavailable from the page (never invent).
        expect(source).toContain(
            "status?.dataset?.mediasourceProgressiveTtfaMeasured === 'true'");
        expect(source).toContain(
            "status?.dataset?.mediasourceProgressiveTtfaUnavailable === 'true'");
        expect(source).toContain('mediasourceProgressiveTtfaP50Ms');
        expect(source).toContain('mediasourceProgressiveTtfaDisclosure');
        expect(source).toContain('assertProgressiveStreamingTtfaMeasured');
        // Playable prefix held open before final write (pre-EOF playing).
        expect(source).toContain('FASTAPI_STUB_PROGRESSIVE_TAIL_HOLD_MS');
        expect(source).toContain('splitFastApiStubMp3ForProgressive');
        expect(source).toContain(
            'assertChromiumDualRequiresProgressiveTtfaMeasured');
        expect(source).toContain('fastapi-server-card-progressive-ttfa');
        // Observed p50 raw forwarded; empty string must not become 0.
        expect(source).toContain('mediasourceProgressiveTtfaP50Raw');
        expect(source).toContain('parseObservedProgressiveTtfaP50Ms');
        expect(source).toContain('setTimeout(() => {');
        expect(source).toContain('FASTAPI_SELECTED_NEEDLE');
        expect(source).toContain('BACKEND_BEFORE_CHOOSE');
        expect(source).toContain('HAVE_CURRENT_DATA');
        expect(source).toContain('fastapiServerCardAcceptance');
        const helper = fs.readFileSync(
            path.join(root, 'scripts', 'fastapi-server-card-acceptance.mjs'),
            'utf8');
        expect(helper).toContain(
            'SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE');
        expect(helper).toContain(
            'SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_MEASURED_NEEDLE');
        expect(helper).toContain('mediasourceProgressiveTtfaNotMeasured');
        expect(helper).toContain('mediasourceProgressiveTtfaP50Ms');
        expect(helper).toContain('FASTAPI_STUB_FIRST_BYTE_DELAY_MS = 100');
        expect(helper).toContain('FASTAPI_STUB_PROGRESSIVE_TAIL_HOLD_MS = 2000');
        expect(helper).toContain('FASTAPI_STUB_PROGRESSIVE_TAIL_RATIO = 0.4');
        expect(helper).toContain('splitFastApiStubMp3ForProgressive');
        expect(helper).toContain('~2.5s');
        const dualIdx = source.indexOf(
            'await acceptTwoBackendComparison(');
        const cardIdx = source.indexOf(
            'await acceptFastApiServerCard(');
        const playableIdx = source.indexOf('SERVER_PLAYABLE_MP3_NEEDLE');
        // Playback-start snapshot must precede chooseServer (status text is replaced).
        const ttfbCaptureIdx = source.indexOf(
            'Capture TTFB / playback-start / MediaSource disclosure BEFORE');
        const mediasourcePassIdx = source.indexOf(
            'mediasourceProgressiveTtfaMeasured:\n' +
            '            ttfb.mediasourceProgressiveTtfaMeasured');
        const chooseIdx = source.indexOf(
            "locator('#chooseServer').click()");
        const seedBeforeChoose = source.indexOf(
            '}, BACKEND_BEFORE_CHOOSE);');
        expect(dualIdx).toBeGreaterThan(0);
        expect(cardIdx).toBeGreaterThan(dualIdx);
        expect(ttfbCaptureIdx).toBeGreaterThan(playableIdx);
        expect(mediasourcePassIdx).toBeGreaterThan(ttfbCaptureIdx);
        expect(chooseIdx).toBeGreaterThan(ttfbCaptureIdx);
        expect(seedBeforeChoose).toBeGreaterThan(ttfbCaptureIdx);
    });

    test('Firefox dual path wires FastAPI card after local dual', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toContain('firefox_fastapi_server_card_acceptance');
        expect(source).toContain('def accept_fastapi_server_card');
        expect(source).toContain('_start_fastapi_speech_stub');
        expect(source).toContain('_minimal_mp3_fixture_bytes');
        expect(source).toContain('HAVE_CURRENT_DATA');
        expect(source).toContain('First body byte (TTFB) p50');
        expect(source).toContain('playback start p50');
        expect(source).toContain('not MediaSource streaming TTFA');
        expect(source).toContain('MediaSource progressive TTFA not measured');
        expect(source).toContain('progressive MediaSource TTFA measured');
        expect(source).toContain('progressive MediaSource TTFA unavailable');
        expect(source).toContain('streamingFirstBodyByteMeasured');
        expect(source).toContain('playbackStartMeasured');
        expect(source).toContain('playbackStartP50Ms');
        expect(source).toContain(
            "status?.dataset?.mediasourceProgressiveTtfaMeasured==='true'");
        expect(source).toContain(
            "status?.dataset?.mediasourceProgressiveTtfaUnavailable==='true'");
        expect(source).toContain('mediasourceProgressiveTtfaP50Ms');
        expect(source).toContain('mediasource_progressive_ttfa_disclosure');
        expect(source).toContain('assert_progressive_streaming_ttfa_measured');
        expect(source).toContain('first_byte_delay_s = 0.1');
        expect(source).toContain('progressive_tail_hold_s = 2.0');
        expect(source).toContain('progressive_tail_ratio = 0.4');
        expect(source).toContain('time.sleep(first_byte_delay_s)');
        expect(source).toContain('time.sleep(progressive_tail_hold_s)');
        expect(source).toContain('mediasourceProgressiveTtfaP50Raw');
        expect(source).toContain('mediasource_progressive_ttfa_p50_raw');
        expect(source).toMatch(
            /find_element\(\s*By\.ID,\s*["']testServer["']\s*\)\.click\(\)/);
        expect(source).toMatch(
            /find_element\(\s*By\.ID,\s*["']chooseServer["']\s*\)\.click\(\)/);
        expect(source).toContain('fastapiServerCardAcceptance');
        expect(source).toContain('backend_before_choose');
        const firefoxHelper = fs.readFileSync(
            path.join(root, 'scripts',
                'firefox_fastapi_server_card_acceptance.py'),
            'utf8');
        expect(firefoxHelper).toContain(
            'mediasource_progressive_ttfa_not_measured');
        expect(firefoxHelper).toContain(
            'mediasourceProgressiveTtfaNotMeasured');
        expect(firefoxHelper).toContain(
            'mediasource_progressive_ttfa_p50_ms');
        expect(firefoxHelper).toContain(
            'mediasource_progressive_ttfa_disclosure');
        const dualIdx = source.indexOf(
            'accept_two_backend_comparison(driver, state["origin"])');
        const cardIdx = source.indexOf(
            'fastapi_card = accept_fastapi_server_card(');
        const ttfbCaptureIdx = source.indexOf(
            'Capture TTFB / playback-start / MediaSource disclosure BEFORE');
        const mediasourcePassIdx = source.indexOf(
            'mediasource_progressive_ttfa_measured=ttfb.get(');
        const chooseIdx = source.indexOf(
            'find_element(By.ID, "chooseServer").click()');
        expect(dualIdx).toBeGreaterThan(0);
        expect(cardIdx).toBeGreaterThan(dualIdx);
        expect(ttfbCaptureIdx).toBeGreaterThan(0);
        expect(mediasourcePassIdx).toBeGreaterThan(ttfbCaptureIdx);
        expect(chooseIdx).toBeGreaterThan(ttfbCaptureIdx);
    });
});
