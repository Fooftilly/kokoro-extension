/** @jest-environment node */
/**
 * Contract for MediaPipe/ONNX overlay controls acceptance (#57).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'overlay-controls-acceptance.mjs')).href;
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as ov from ${JSON.stringify(helperUrl)};
const onnxSeed = ov.overlaySeedForBackend('onnx', { includeUnsupported: true });
const mpSeed = ov.overlaySeedForBackend('mediapipe', { includeUnsupported: false });
ov.assertOverlayWavSnapshot({
    sampleRateHz: 24000, audioBytes: 1000, initiallyPaused: true,
});
ov.assertOverlaySettings({ rate: 1.25, volume: 0.4, paused: true });
ov.assertOverlayPlaybackConfirmed({
    playingEvent: true, startTime: 0, currentTime: 0.05,
    paused: false, button: 'Pause', readyState: 2,
});
ov.assertOverlayPausedAfterToggle({ paused: true, button: 'Play' });
let pendingRejected = false;
try {
    // Status + !paused alone must not count — play() may still be pending.
    ov.assertOverlayPlaybackConfirmed({
        status: ov.expectedOverlayPlayingStatus(0, 3),
        paused: false, button: 'Pause', readyState: 2,
        playingEvent: false, startTime: 0, currentTime: 0,
    });
} catch { pendingRejected = true; }
let stuckTimeRejected = false;
try {
    ov.assertOverlayPlaybackConfirmed({
        playingEvent: true, startTime: 0, currentTime: 0,
        paused: false, button: 'Pause', readyState: 2,
    });
} catch { stuckTimeRejected = true; }
const onnxReport = ov.buildOverlayControlsReport({
    backend: 'onnx', includeRetry: true, playPauseToggled: true,
    playbackConfirmed: true,
    unsupportedSentenceRejected: true, retryRestoredAudio: true,
    sampleRateHz: 24000, audioBytes: 1000, rate: 1.25, volume: 0.4,
});
const mpReport = ov.buildOverlayControlsReport({
    backend: 'mediapipe', includeRetry: false, playPauseToggled: true,
    playbackConfirmed: true,
    sampleRateHz: 24000, audioBytes: 1000, rate: 1.25, volume: 0.4,
});
let rejected = false;
try { ov.overlaySeedForBackend('fastapi'); } catch { rejected = true; }
console.log(JSON.stringify({
    allowed: [...ov.ALLOWED_OVERLAY_BACKENDS],
    playingStatus: ov.expectedOverlayPlayingStatus(0, 3),
    onnxSeed, mpSeed, onnxReport, mpReport, rejected,
    pendingRejected, stuckTimeRejected,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('overlay controls acceptance', () => {
    test('shared helper seeds, asserts, and builds reports', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.allowed).toEqual(['onnx', 'mediapipe']);
        expect(snap.onnxSeed.pendingTtsBackend).toBe('onnx');
        expect(snap.onnxSeed.pendingContent[2].content).toBe('zzzzqwertyword.');
        expect(snap.mpSeed.pendingTtsBackend).toBe('mediapipe');
        expect(snap.mpSeed.pendingContent[2].content).toBe('Hello again.');
        expect(snap.playingStatus).toBe('Playing sentence 1/3');
        expect(snap.pendingRejected).toBe(true);
        expect(snap.stuckTimeRejected).toBe(true);
        expect(snap.onnxReport).toEqual(expect.objectContaining({
            success: true,
            backend: 'onnx',
            playPauseToggled: true,
            playbackConfirmed: true,
            unsupportedSentenceRejected: true,
            retryRestoredAudio: true,
            retryNotApplicable: false,
        }));
        expect(snap.onnxReport.controls).toContain('retry-after-error');
        expect(snap.mpReport).toEqual(expect.objectContaining({
            success: true,
            backend: 'mediapipe',
            playPauseToggled: true,
            playbackConfirmed: true,
            retryNotApplicable: true,
            unsupportedSentenceRejected: false,
        }));
        expect(snap.mpReport.controls).toContain('play-pause');
        expect(snap.mpReport.controls).not.toContain('retry-after-error');
        expect(snap.rejected).toBe(true);
    });

    test('Chromium and Firefox wire MediaPipe overlay on origin scopes', () => {
        const chromium = fs.readFileSync(chromiumLive, 'utf8');
        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        expect(chromium).toContain('overlay-controls-acceptance.mjs');
        expect(chromium).toContain('assertOverlayPlaybackConfirmed');
        expect(chromium).toContain('__kokoroPlayProof');
        expect(chromium).toContain("addEventListener('playing'");
        expect(chromium).toContain("page.context().newPage()");
        expect(chromium).toContain("waitForSelector('#audio', { state: 'attached'");
        // Seed must use the existing extension page, not the blank overlay tab.
        const seedIdx = chromium.indexOf(
            'await page.evaluate(async storage => {\n' +
            '        await chrome.storage.local.set(storage);\n' +
            '    }, seed);');
        const newPageIdx = chromium.indexOf('page.context().newPage()');
        expect(seedIdx).toBeGreaterThan(0);
        expect(newPageIdx).toBeGreaterThan(seedIdx);
        expect(firefox).toContain('firefox_overlay_controls_acceptance');
        expect(firefox).toContain('assert_overlay_playback_confirmed');
        expect(firefox).toContain('__kokoroPlayProof');
        expect(firefox).toContain("addEventListener('playing'");
        // Match await/assignment call sites — not helper declarations.
        const chromiumOnnx = chromium.indexOf(
            "await acceptOverlayControls(\n                    page, extensionId, 'onnx')");
        const chromiumMp = chromium.indexOf(
            "await acceptOverlayControls(\n                    page, extensionId, 'mediapipe')");
        expect(chromiumOnnx).toBeGreaterThan(0);
        expect(chromiumMp).toBeGreaterThan(chromiumOnnx);
        const firefoxOnnx = firefox.indexOf(
            'run_offline_overlay_controls_acceptance(\n                    driver, state["origin"], "onnx")');
        const firefoxMp = firefox.indexOf(
            'run_offline_overlay_controls_acceptance(\n                        driver, state["origin"], "mediapipe")');
        expect(firefoxOnnx).toBeGreaterThan(0);
        expect(firefoxMp).toBeGreaterThan(firefoxOnnx);
    });
});

