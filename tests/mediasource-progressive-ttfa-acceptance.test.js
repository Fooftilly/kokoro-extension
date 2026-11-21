/** @jest-environment node */
/**
 * Contract for progressive MediaSource TTFA measurement + fail-closed
 * unavailable path (#61). Never invent TTFA numbers.
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
const productHelper = path.join(root, 'mediasource-progressive-ttfa.js');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as mse from ${JSON.stringify(helperUrl)};
const unmeasured = mse.assertProgressiveStreamingTtfaUnmeasured({
    progressiveStreamingTtfaMeasured: false,
    trueMediaSourceTtfaMeasured: false,
    disclosureNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_NOT_MEASURED_NEEDLE,
});
const measured = mse.assertProgressiveStreamingTtfaMeasured({
    progressiveStreamingTtfaMeasured: true,
    trueMediaSourceTtfaMeasured: true,
    progressiveStreamingTtfaP50Ms: 240,
    usedMediaSource: true,
    disclosureNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_MEASURED_NEEDLE,
});
const unavailable = mse.assertProgressiveStreamingTtfaMeasured({
    progressiveStreamingTtfaMeasured: false,
    progressiveStreamingTtfaUnavailable: true,
    progressiveStreamingTtfaP50Ms: null,
    usedMediaSource: false,
    disclosureNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_UNAVAILABLE_NEEDLE,
});
const failInvented = (() => {
    try {
        mse.assertProgressiveStreamingTtfaMeasured({
            progressiveStreamingTtfaMeasured: false,
            progressiveStreamingTtfaUnavailable: true,
            progressiveStreamingTtfaP50Ms: 12,
            disclosureNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_UNAVAILABLE_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failMissingP50 = (() => {
    try {
        mse.assertProgressiveStreamingTtfaMeasured({
            progressiveStreamingTtfaMeasured: true,
            trueMediaSourceTtfaMeasured: true,
            usedMediaSource: true,
            disclosureNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_MEASURED_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const report = mse.buildProgressiveStreamingTtfaMeasuredReport({
    browser: 'Firefox',
    ttfaP50Ms: 180,
    usedMediaSource: true,
});
console.log(JSON.stringify({
    measuredNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_MEASURED_NEEDLE,
    unavailableNeedle: mse.PROGRESSIVE_MEDIASOURCE_TTFA_UNAVAILABLE_NEEDLE,
    unmeasured, measured, unavailable, failInvented, failMissingP50, report,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('progressive MediaSource TTFA measured acceptance', () => {
    test('shared helper measures or fail-closes without inventing numbers', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.measuredNeedle).toBe(
            'progressive MediaSource TTFA measured');
        expect(snap.unavailableNeedle).toBe(
            'progressive MediaSource TTFA unavailable');
        expect(snap.unmeasured).toEqual(expect.objectContaining({
            success: true,
            progressiveStreamingTtfaMeasured: false,
        }));
        expect(snap.measured).toEqual(expect.objectContaining({
            success: true,
            progressiveStreamingTtfaMeasured: true,
            progressiveStreamingTtfaP50Ms: 240,
            usedMediaSource: true,
        }));
        expect(snap.unavailable).toEqual(expect.objectContaining({
            success: true,
            progressiveStreamingTtfaMeasured: false,
            progressiveStreamingTtfaUnavailable: true,
            progressiveStreamingTtfaP50Ms: null,
        }));
        expect(snap.failInvented.ok).toBe(false);
        expect(snap.failInvented.message).toMatch(/must not invent TTFA/i);
        expect(snap.failMissingP50.ok).toBe(false);
        expect(snap.failMissingP50.message).toMatch(
            /progressiveStreamingTtfaP50Ms must be a finite/i);
        expect(snap.report).toEqual(expect.objectContaining({
            progressiveStreamingTtfaMeasured: true,
            progressiveStreamingTtfaP50Ms: 180,
            usedMediaSource: true,
        }));
    });

    test('product helper probes MediaSource without inventing TTFA', () => {
        const source = fs.readFileSync(productHelper, 'utf8');
        expect(source).toContain('measureProgressiveMediaSourceTtfa');
        expect(source).toContain('probeMediaSourceProgressiveMp3Support');
        expect(source).toContain('MediaSource.isTypeSupported');
        expect(source).toContain('appendBuffer');
        expect(source).toContain('unavailable: true');
        expect(source).toContain('ttfaMs: null');
        expect(source).toContain('cancelReadableStreamBody');
        expect(source).toContain('AbortController');
        expect(source).toContain('state.aborted');
        // PR Lens: finish/cleanup must clear deadline + playing listeners.
        expect(source).toContain('detachPlaying');
        expect(source).toContain('deadlineTimer');
        expect(source).toContain('clearTimeout(state.deadlineTimer)');
        expect(source).toContain('state.detachPlaying?.()');
        expect(source).toContain('promise.catch(() => {})');
        // Locked-stream: cancel via reader + releaseLock; no body.cancel while locked.
        expect(source).toContain('releaseLock');
        expect(source).toContain('readerAcquired');
        expect(source).toContain('playedBeforeEof');
        expect(source).toContain('bodyClosed');
        expect(source).not.toContain('watchReaderBodyClosed');
        expect(source).toContain('streamDone');
        expect(source).toMatch(/after stream EOF/);
        expect(source).not.toMatch(/ttfaMs\s*[:=]\s*\d+/);
    });

    test('FastAPI card accepts measured progressive TTFA with finite p50', () => {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as card from ${JSON.stringify(pathToFileURL(fastapiCard).href)};
const measured = card.buildFastApiServerCardReport({
    mediasourceProgressiveTtfaMeasured: true,
    mediasourceProgressiveTtfaNotMeasured: false,
    mediasourceProgressiveTtfaUnavailable: false,
    mediasourceProgressiveTtfaP50Ms: 255,
    usedMediaSource: true,
    mediasourceProgressiveTtfaDisclosure:
        card.SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_MEASURED_NEEDLE,
});
const unavailable = card.buildFastApiServerCardReport({
    mediasourceProgressiveTtfaMeasured: false,
    mediasourceProgressiveTtfaNotMeasured: true,
    mediasourceProgressiveTtfaUnavailable: true,
    mediasourceProgressiveTtfaP50Ms: null,
    usedMediaSource: false,
    mediasourceProgressiveTtfaDisclosure:
        card.SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_UNAVAILABLE_NEEDLE,
});
const invent = (() => {
    try {
        card.buildFastApiServerCardReport({
            mediasourceProgressiveTtfaMeasured: false,
            mediasourceProgressiveTtfaNotMeasured: true,
            mediasourceProgressiveTtfaUnavailable: true,
            mediasourceProgressiveTtfaP50Ms: 99,
            mediasourceProgressiveTtfaDisclosure:
                card.SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_UNAVAILABLE_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const inventBlankRaw = (() => {
    try {
        card.buildFastApiServerCardReport({
            mediasourceProgressiveTtfaMeasured: false,
            mediasourceProgressiveTtfaNotMeasured: true,
            mediasourceProgressiveTtfaUnavailable: true,
            mediasourceProgressiveTtfaP50Raw: ' ',
            mediasourceProgressiveTtfaP50Ms: 250,
            mediasourceProgressiveTtfaDisclosure:
                card.SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_UNAVAILABLE_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    measuredP50: measured.mediasourceProgressiveTtfaP50Ms,
    unavailableMeasured: unavailable.mediasourceProgressiveTtfaMeasured,
    invent,
    inventBlankRaw,
}));
`], { encoding: 'utf8', cwd: root });
        expect(child.status).toBe(0);
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.measuredP50).toBe(255);
        expect(snap.unavailableMeasured).toBe(false);
        expect(snap.invent.ok).toBe(false);
        expect(snap.invent.message).toMatch(/must not invent p50/i);
        expect(snap.inventBlankRaw.ok).toBe(false);
        expect(snap.inventBlankRaw.message).toMatch(/must not invent p50/i);
    });

    test('source wiring: dual live asserts measured or unavailable progressive TTFA', () => {
        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        const chromium = fs.readFileSync(chromiumLive, 'utf8');
        const helper = fs.readFileSync(path.join(
            root, 'scripts', 'mediasource-progressive-ttfa-acceptance.mjs'),
        'utf8');
        const page = fs.readFileSync(
            path.join(root, 'model-manager-page.js'), 'utf8');

        expect(helper).toContain('assertProgressiveStreamingTtfaMeasured');
        expect(helper).toContain('buildProgressiveStreamingTtfaMeasuredReport');
        expect(helper).toContain('progressiveStreamingTtfaP50Ms');
        expect(page).toContain('measureProgressiveMediaSourceTtfa');
        expect(page).toContain('mediasourceProgressiveTtfaP50Ms');
        expect(page).toContain('progressive MediaSource TTFA measured');
        expect(page).toContain('progressive MediaSource TTFA unavailable');

        expect(firefox).toContain('assert_progressive_streaming_ttfa_measured');
        expect(firefox).toContain('progressiveStreamingTtfaUnavailable');
        expect(firefox).toContain('mediasourceProgressiveTtfaP50Ms');
        expect(chromium).toContain('assertProgressiveStreamingTtfaMeasured');
        expect(chromium).toContain('progressiveStreamingTtfaP50Ms');
        expect(chromium).toContain('SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_MEASURED_NEEDLE');
        const chromiumLift = chromium.indexOf(
            'Progressive MediaSource TTFA measured/unavailable');
        expect(chromiumLift).toBeGreaterThan(0);
    });
});
