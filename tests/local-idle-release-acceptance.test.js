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
const joinOk = idle.measureCloseJoinMs(1000, 1080.5);
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
const failCloseJoin = (() => {
    try {
        idle.measureCloseJoinMs(50, 40);
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const lateWaitWouldUnderstate = (() => {
    // Codex/Devin: idle-timer arithmetic after a late waitStarted understates
    // teardown. close()-boundary join keeps the full native close duration.
    const closeStarted = 200;
    const closeEnded = 280;
    const configuredIdleMs = 100;
    const lateWaitStarted = 290; // after 90ms of pre-wait work past arm
    const observedFromLateWait = 380 - lateWaitStarted; // 90
    const understated = Math.max(0, observedFromLateWait - configuredIdleMs);
    const closeJoin = idle.measureCloseJoinMs(closeStarted, closeEnded);
    return { understated, closeJoin };
})();
const rejectedNativeClose = await (async () => {
    // Cleared refs + rejected native teardown must not mark closed.
    let refsCleared = false;
    const instrument = idle.createCloseJoinInstrument(async () => {
        refsCleared = true;
        throw new Error('Native release failed');
    });
    let rejected = false;
    try {
        await instrument.close();
    } catch (error) {
        rejected = String(error.message || error).includes('Native release failed');
    }
    return {
        refsCleared,
        rejected,
        closed: instrument.closed,
        joinMs: instrument.joinMs,
    };
})();
const fulfilledNativeClose = await (async () => {
    const instrument = idle.createCloseJoinInstrument(async () => {});
    await instrument.close();
    return {
        closed: instrument.closed,
        joinFinite: Number.isFinite(instrument.joinMs) && instrument.joinMs >= 0,
    };
})();
console.log(JSON.stringify({
    needle: idle.LOCAL_IDLE_RELEASE_MEASURED_NEEDLE,
    backends: idle.DUAL_IDLE_RELEASE_BACKENDS,
    report,
    joinOk,
    failMissing,
    failJoin,
    failUnmeasured,
    failCloseJoin,
    lateWaitWouldUnderstate,
    rejectedNativeClose,
    fulfilledNativeClose,
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
        expect(snap.joinOk).toBe(80.5);
        expect(snap.failMissing.ok).toBe(false);
        expect(snap.failMissing.message).toMatch(/onnx \+ mediapipe/);
        expect(snap.failJoin.ok).toBe(false);
        expect(snap.failJoin.message).toMatch(/idleReleaseJoinMs/);
        expect(snap.failUnmeasured.ok).toBe(false);
        expect(snap.failUnmeasured.message).toMatch(/localIdleReleaseMeasured/);
        expect(snap.failCloseJoin.ok).toBe(false);
        expect(snap.lateWaitWouldUnderstate.understated).toBe(0);
        expect(snap.lateWaitWouldUnderstate.closeJoin).toBe(80);
        expect(snap.rejectedNativeClose).toEqual({
            refsCleared: true,
            rejected: true,
            closed: false,
            joinMs: null,
        });
        expect(snap.fulfilledNativeClose.closed).toBe(true);
        expect(snap.fulfilledNativeClose.joinFinite).toBe(true);
    });

    test('live harnesses gate dual idle release for both browsers', () => {
        const chromium = fs.readFileSync(chromiumLive, 'utf8');
        expect(chromium).toContain('local-idle-release-acceptance.mjs');
        expect(chromium).toContain('assertLocalIdleReleaseDual');
        expect(chromium).toContain('localIdleReleaseAcceptance');
        expect(chromium).toContain('local-idle-release-dual');
        expect(chromium).toContain(
            'Chromium local provider idle release failed');
        // Failure attribution: mark success:false before asserts.
        expect(chromium).toContain("stage: 'local-idle-release-dual'");
        expect(chromium).toContain('assertLocalIdleReleaseProbe(probe, backend)');

        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        expect(firefox).toContain('local-idle-release-acceptance.mjs');
        expect(firefox).toContain('assertLocalIdleReleaseDual');
        expect(firefox).toContain('localIdleReleaseAcceptance');
        expect(firefox).toContain('local-idle-release-dual');
    });

    test('probe measures native close() join and checks both teardowns', () => {
        const probe = fs.readFileSync(probeSource, 'utf8');
        expect(probe).toContain('instrumentCloseJoin');
        expect(probe).toContain('idleReleaseJoinMs');
        expect(probe).toContain('repeatedIdleReleaseJoinMs');
        expect(probe).toContain('nativeRefsReleased');
        expect(probe).toContain('Repeated idle close did not clear model references');
        // Must not subtract configuredIdleMs from a late waitStarted clock.
        expect(probe).not.toContain(
            'Math.max(0, observedMs - configuredIdleMs)');
        expect(probe).toContain('performance.now() - startedAt');
        // Failed native teardown must not mark closed in finally.
        expect(probe).not.toMatch(
            /await nativeClose\(\);\s*\}\s*finally\s*\{[^}]*closed = true/);
        expect(probe).toContain('await nativeClose();\n            joinMs =');
    });
});
