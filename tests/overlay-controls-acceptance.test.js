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
    status: ov.expectedOverlayPlayingStatus(0, 3),
    paused: false, button: 'Pause', readyState: 2,
    sentenceIndex: 0, sentenceCount: 3,
});
ov.assertOverlayPausedAfterToggle({ paused: true, button: 'Play' });
let pendingRejected = false;
try {
    ov.assertOverlayPlaybackConfirmed({
        status: 'Pause', paused: false, button: 'Pause', readyState: 2,
    });
} catch { pendingRejected = true; }
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
    onnxSeed, mpSeed, onnxReport, mpReport, rejected, pendingRejected,
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
        expect(chromium).toContain('expectedOverlayPlayingStatus');
        expect(firefox).toContain('firefox_overlay_controls_acceptance');
        expect(firefox).toContain('assert_overlay_playback_confirmed');
        expect(firefox).toContain('expected_overlay_playing_status');
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

