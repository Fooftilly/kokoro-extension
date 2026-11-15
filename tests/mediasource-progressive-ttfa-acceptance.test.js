/** @jest-environment node */
/**
 * Contract for progressive MediaSource TTFA still-unmeasured scaffolding
 * (#61 / KE-54). Fail closed if measured is claimed; no fake TTFA numbers.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'mediasource-progressive-ttfa-acceptance.mjs'))
    .href;
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const fastapiCard = path.join(
    root, 'scripts', 'fastapi-server-card-acceptance.mjs');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as mse from ${JSON.stringify(helperUrl)};
const ok = mse.assertProgressiveStreamingTtfaUnmeasured({
    progressiveStreamingTtfaMeasured: false,
    trueMediaSourceTtfaMeasured: false,
    disclosureNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_NOT_MEASURED_NEEDLE,
});
const fromCard = mse.assertProgressiveStreamingTtfaUnmeasured({
    mediasourceProgressiveTtfaMeasured: false,
    mediasourceProgressiveTtfaNotMeasured: true,
    mediasourceProgressiveTtfaDisclosure:
        mse.MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE,
});
const report = mse.buildProgressiveStreamingTtfaReport({
    browser: 'Firefox',
    assertedFromServerCard: true,
});
const failProgressive = (() => {
    try {
        mse.assertProgressiveStreamingTtfaUnmeasured({
            progressiveStreamingTtfaMeasured: true,
            trueMediaSourceTtfaMeasured: false,
            disclosureNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_NOT_MEASURED_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failTrueMs = (() => {
    try {
        mse.assertProgressiveStreamingTtfaUnmeasured({
            progressiveStreamingTtfaMeasured: false,
            trueMediaSourceTtfaMeasured: true,
            disclosureNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_NOT_MEASURED_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failMissing = (() => {
    try {
        mse.assertProgressiveStreamingTtfaUnmeasured({
            disclosureNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_NOT_MEASURED_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failNeedle = (() => {
    try {
        mse.assertProgressiveStreamingTtfaUnmeasured({
            progressiveStreamingTtfaMeasured: false,
            trueMediaSourceTtfaMeasured: false,
            disclosureNeedle: 'playback start measured only',
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    needle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_NOT_MEASURED_NEEDLE,
    pageNeedle: mse.MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE,
    ok, fromCard, report, failProgressive, failTrueMs, failMissing, failNeedle,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('progressive MediaSource TTFA unmeasured acceptance (KE-54)', () => {
    test('shared helper asserts unmeasured flags and builds dual report', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.needle).toBe('progressive MediaSource TTFA not measured');
        expect(snap.pageNeedle).toBe(
            'MediaSource progressive TTFA not measured');
        expect(snap.ok).toEqual(expect.objectContaining({
            success: true,
            progressiveStreamingTtfaMeasured: false,
            trueMediaSourceTtfaMeasured: false,
        }));
        expect(snap.fromCard).toEqual(expect.objectContaining({
            success: true,
            progressiveStreamingTtfaMeasured: false,
            trueMediaSourceTtfaMeasured: false,
        }));
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            progressiveStreamingTtfaMeasured: false,
            trueMediaSourceTtfaMeasured: false,
            assertedFromServerCard: true,
            disclosureNeedle: 'progressive MediaSource TTFA not measured',
        }));
        expect(snap.failProgressive.ok).toBe(false);
        expect(snap.failProgressive.message).toMatch(
            /progressiveStreamingTtfaMeasured must be false/i);
        expect(snap.failTrueMs.ok).toBe(false);
        expect(snap.failTrueMs.message).toMatch(
            /trueMediaSourceTtfaMeasured must be false/i);
        expect(snap.failMissing.ok).toBe(false);
        expect(snap.failMissing.message).toMatch(
            /must be false|not measured/i);
        expect(snap.failNeedle.ok).toBe(false);
        expect(snap.failNeedle.message).toMatch(/disclosure needle missing/i);
    });

    test('fail closed when FastAPI card claims MediaSource TTFA measured', () => {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as mse from ${JSON.stringify(helperUrl)};
import * as card from ${JSON.stringify(pathToFileURL(fastapiCard).href)};
const claimed = (() => {
    try {
        mse.assertProgressiveStreamingTtfaUnmeasured({
            mediasourceProgressiveTtfaMeasured: true,
            mediasourceProgressiveTtfaNotMeasured: false,
            mediasourceProgressiveTtfaDisclosure:
                mse.MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
// buildFastApiServerCardReport itself fails closed on measured=true via KE-41c.
const buildClaim = (() => {
    try {
        card.buildFastApiServerCardReport({
            mediasourceProgressiveTtfaMeasured: true,
            mediasourceProgressiveTtfaNotMeasured: false,
            mediasourceProgressiveTtfaDisclosure: '',
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const okCard = card.buildFastApiServerCardReport({});
mse.assertProgressiveStreamingTtfaUnmeasured(okCard);
console.log(JSON.stringify({ claimed, buildClaim, okCardMapped: true }));
`], { encoding: 'utf8', cwd: root });
        expect(child.status).toBe(0);
        const snap = JSON.parse(child.stdout.trim());
        // Never invent a measured progressive TTFA — both paths fail closed.
        expect(snap.claimed.ok).toBe(false);
        expect(snap.claimed.message).toMatch(
            /progressiveStreamingTtfaMeasured must be false|trueMediaSourceTtfaMeasured must be false/i);
        expect(snap.buildClaim.ok).toBe(false);
        expect(snap.buildClaim.message).toMatch(
            /mediasourceProgressiveTtfaMeasured must be false|not measured/i);
        expect(snap.okCardMapped).toBe(true);
    });

    test('source wiring: dual live asserts from FastAPI/MediaSource stage', () => {
        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        const chromium = fs.readFileSync(chromiumLive, 'utf8');
        const helper = fs.readFileSync(path.join(
            root, 'scripts', 'mediasource-progressive-ttfa-acceptance.mjs'),
        'utf8');

        expect(helper).toContain('assertProgressiveStreamingTtfaUnmeasured');
        expect(helper).toContain('buildProgressiveStreamingTtfaReport');
        expect(helper).toContain('progressiveStreamingTtfaMeasured');
        expect(helper).toContain('trueMediaSourceTtfaMeasured');
        expect(helper).toContain('progressive MediaSource TTFA not measured');
        expect(helper).not.toMatch(/ttfaMs\s*[:=]/);
        expect(helper).not.toMatch(/firstAudioP50/);

        expect(firefox).toContain(
            'mediasource-progressive-ttfa-acceptance.mjs');
        expect(firefox).toContain(
            'assert_progressive_streaming_ttfa_unmeasured');
        expect(firefox).toContain('progressiveStreamingTtfaAcceptance');
        const dualGate = firefox.indexOf('if dual_comparison:');
        const cardCall = firefox.indexOf(
            'fastapi_card = accept_fastapi_server_card(');
        const progressiveAssert = firefox.indexOf(
            'assert_progressive_streaming_ttfa_unmeasured');
        const progressiveLift = firefox.indexOf(
            'acceptance missing verified server-card');
        expect(dualGate).toBeGreaterThan(0);
        expect(cardCall).toBeGreaterThan(dualGate);
        expect(progressiveAssert).toBeGreaterThan(0);
        expect(progressiveLift).toBeGreaterThan(cardCall);

        expect(chromium).toContain(
            'mediasource-progressive-ttfa-acceptance.mjs');
        expect(chromium).toContain(
            'assertProgressiveStreamingTtfaUnmeasured');
        expect(chromium).toContain('progressiveStreamingTtfaAcceptance');
        expect(chromium).toContain('buildProgressiveStreamingTtfaReport');
        const chromiumDualGate = chromium.indexOf(
            "providerFilter === 'both' && !originDownload");
        const chromiumCard = chromium.indexOf(
            'fastapiServerCardAcceptance = await acceptFastApiServerCard(');
        const chromiumAssert = chromium.indexOf(
            'assertProgressiveStreamingTtfaUnmeasured(report)');
        const chromiumLift = chromium.indexOf(
            'Progressive MediaSource TTFA unmeasured acceptance');
        expect(chromiumDualGate).toBeGreaterThan(0);
        expect(chromiumCard).toBeGreaterThan(chromiumDualGate);
        expect(chromiumAssert).toBeGreaterThan(0);
        expect(chromiumLift).toBeGreaterThan(chromiumCard);
        // Assert runs inside acceptFastApiServerCard before the dual lift.
        expect(chromiumAssert).toBeLessThan(chromiumCard);
    });
});
