/** @jest-environment node */
/**
 * Dual-gated local idle-release measurement (#57 / #61).
 * Origin already probes; dual must require both backends offline.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'local-idle-release-acceptance.mjs')).href;
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const probeSource = path.join(root, 'scripts', 'local-provider-idle-probe.mjs');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as idle from ${JSON.stringify(helperUrl)};
function validProbe(backend = 'onnx') {
    return {
        success: true,
        backend,
        configuredIdleMs: 100,
        idleReleaseJoinMs: 12.5,
        repeatedIdleReleaseJoinMs: 8,
        nativeModelReferencesReleased: true,
        cachedAudioPreservedByteForByte: true,
        cachedReplayDidNotReloadModel: true,
        freshProviderSynthesizedAfterIdle: true,
        repeatedIdleRelease: true,
        sampleRateHz: 24000,
        offline: true,
    };
}
const report = idle.buildLocalIdleReleaseDualReport({
    browser: 'chromium',
    backends: [validProbe('onnx'), validProbe('mediapipe')],
});
idle.assertLocalIdleReleaseDual(report);
const failMissing = (() => {
    try {
        idle.assertLocalIdleReleaseDual(idle.buildLocalIdleReleaseDualReport({
            backends: [validProbe('onnx')],
        }));
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failJoin = (() => {
    try {
        idle.assertLocalIdleReleaseProbe({
            ...validProbe('onnx'), idleReleaseJoinMs: -1,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failUnmeasured = (() => {
    try {
        idle.assertLocalIdleReleaseDual(idle.buildLocalIdleReleaseDualReport({
            localIdleReleaseMeasured: false,
            backends: [validProbe('onnx'), validProbe('mediapipe')],
        }));
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    needle: idle.LOCAL_IDLE_RELEASE_MEASURED_NEEDLE,
    backends: idle.DUAL_IDLE_RELEASE_BACKENDS,
    report,
    failMissing,
    failJoin,
    failUnmeasured,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('local idle-release dual acceptance', () => {
    test('accepts both backends with measured join latencies', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.needle).toBe('local idle release measured');
        expect(snap.backends).toEqual(['onnx', 'mediapipe']);
        expect(snap.report.localIdleReleaseMeasured).toBe(true);
        expect(snap.report.success).toBe(true);
        expect(snap.failMissing.ok).toBe(false);
        expect(snap.failMissing.message).toMatch(/onnx \+ mediapipe/);
        expect(snap.failJoin.ok).toBe(false);
        expect(snap.failJoin.message).toMatch(/idleReleaseJoinMs/);
        expect(snap.failUnmeasured.ok).toBe(false);
        expect(snap.failUnmeasured.message).toMatch(/localIdleReleaseMeasured/);
    });

    test('live harnesses gate dual idle release for both browsers', () => {
        const chromium = fs.readFileSync(chromiumLive, 'utf8');
        expect(chromium).toContain('local-idle-release-acceptance.mjs');
        expect(chromium).toContain('assertLocalIdleReleaseDual');
        expect(chromium).toContain('localIdleReleaseAcceptance');
        expect(chromium).toContain('local-idle-release-dual');
        expect(chromium).toContain(
            'Chromium local provider idle release failed');

        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        expect(firefox).toContain('local-idle-release-acceptance.mjs');
        expect(firefox).toContain('assertLocalIdleReleaseDual');
        expect(firefox).toContain('localIdleReleaseAcceptance');
        expect(firefox).toContain('local-idle-release-dual');
    });

    test('probe returns measured join latencies after configured idle', () => {
        const probe = fs.readFileSync(probeSource, 'utf8');
        expect(probe).toContain('idleReleaseJoinMs');
        expect(probe).toContain('repeatedIdleReleaseJoinMs');
        expect(probe).toContain('configuredIdleMs');
        expect(probe).toContain('Math.max(0, observedMs - configuredIdleMs)');
    });
});
