/** @jest-environment node */
/**
 * Contract for Chromium live report intermediate vs completed shapes.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'live-chromium-report.mjs')).href;
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as rep from ${JSON.stringify(helperUrl)};
const mid = rep.buildCurrentProviderSnapshot({
    provider: 'mediapipe',
    variant: 'cpu',
    stage: 'offline-mediapipe-overlay-controls',
    mediapipeOverlayAcceptance: { success: true, playbackConfirmed: true },
});
const intermediate = {
    results: [],
    currentProvider: mid,
};
rep.assertIntermediateLiveReport(intermediate, {
    provider: 'mediapipe',
    stage: 'offline-mediapipe-overlay-controls',
    requireMediapipeOverlay: true,
});
let earlyFinalizeRejected = false;
try {
    rep.assertIntermediateLiveReport({
        results: [{
            provider: 'mediapipe',
            mediapipeOverlayAcceptance: { success: true },
        }],
        currentProvider: mid,
    }, { requireMediapipeOverlay: true });
} catch { earlyFinalizeRejected = true; }
const completed = {
    results: [{
        provider: 'mediapipe',
        variant: 'cpu',
        success: true,
        mediapipeOverlayAcceptance: { success: true, playbackConfirmed: true },
        localBenchmarkAcceptance: { success: true },
    }],
    currentProvider: null,
};
rep.assertCompletedLiveReport(completed, {
    provider: 'mediapipe',
    requireMediapipeOverlay: true,
    requireLocalBenchmark: true,
});
let unclearedRejected = false;
try {
    rep.assertCompletedLiveReport({
        results: completed.results,
        currentProvider: mid,
    }, { provider: 'mediapipe', requireMediapipeOverlay: true });
} catch { unclearedRejected = true; }
let missingProviderRejected = false;
try {
    rep.buildCurrentProviderSnapshot({ variant: 'cpu', stage: 'x' });
} catch { missingProviderRejected = true; }
console.log(JSON.stringify({
    mid, earlyFinalizeRejected, unclearedRejected, missingProviderRejected,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('live chromium report shapes', () => {
    test('intermediate currentProvider vs completed results[] contract', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.mid.provider).toBe('mediapipe');
        expect(snap.mid.stage).toBe('offline-mediapipe-overlay-controls');
        expect(snap.mid.mediapipeOverlayAcceptance.success).toBe(true);
        expect(snap.earlyFinalizeRejected).toBe(true);
        expect(snap.unclearedRejected).toBe(true);
        expect(snap.missingProviderRejected).toBe(true);
    });

    test('Chromium live harness wires snapshot helper into saveReport path', () => {
        const src = fs.readFileSync(chromiumLive, 'utf8');
        expect(src).toContain("from './live-chromium-report.mjs'");
        expect(src).toContain('buildCurrentProviderSnapshot');
        expect(src).toContain('currentProvider');
        expect(src).toMatch(/saveReport\(currentProviderSnapshot\(\)\)/);
    });
});
