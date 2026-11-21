/** @jest-environment node */
/**
 * Contract checks for long-form memory acceptance — keep this file's shape
 * distinct from article-selection-acceptance.test.js (Sonar new-code duplication).
 * KE-52 walk + leave-open objective waveform quality measured; MOS unmeasured.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'long-form-memory-acceptance.mjs')).href;

function loadHelperSnapshot() {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as longForm from ${JSON.stringify(helperUrl)};
const speech = longForm.buildLongFormSpeechLines();
const pending = longForm.buildLongFormPendingContent();
const cfg = longForm.longFormStorageConfig('onnx');
const visits = longForm.buildLongFormVisitIndexes();
const sampleStats = {
    cacheSize: 4,
    objectUrlCount: 3,
    sentenceCount: longForm.LONG_FORM_SENTENCE_COUNT,
    window: { first: 0, last: 4 },
};
const qualitySamples = [
    longForm.buildLongFormQualitySampleFixture({ index: 0, rms: 0.03 }),
    longForm.buildLongFormQualitySampleFixture({ index: 6, rms: 0.04 }),
    longForm.buildLongFormQualitySampleFixture({ index: 12, rms: 0.05 }),
    longForm.buildLongFormQualitySampleFixture({
        index: 35, rms: 0.045, durationSec: 1.2,
    }),
];
const capture = (fn) => {
    try { fn(); return { ok: true }; }
    catch (error) { return { ok: false, message: String(error.message || error) }; }
};
const finalized = longForm.finalizeLongFormMemoryAcceptanceReport({
    success: true,
    browser: 'chromium',
    backend: 'onnx',
    maxCacheSize: 4,
    samples: qualitySamples,
});
const qualityOffFail = capture(() => longForm.assertLongFormMemoryAcceptanceReport({
    success: true,
    sentenceCount: longForm.LONG_FORM_SENTENCE_COUNT,
    longFormQualityMeasured: false,
    longFormMosMeasured: false,
    longFormQualityDisclosure: longForm.LONG_FORM_QUALITY_MEASURED_NEEDLE,
    samples: qualitySamples,
}));
const mosClaimFail = capture(() => longForm.assertLongFormMemoryAcceptanceReport({
    success: true,
    sentenceCount: longForm.LONG_FORM_SENTENCE_COUNT,
    longFormQualityMeasured: true,
    longFormMosMeasured: true,
    longFormQualityDisclosure: longForm.LONG_FORM_QUALITY_MEASURED_NEEDLE,
    samples: qualitySamples,
}));
const silentFail = capture(() => longForm.assertLongFormWaveformQuality([
    ...qualitySamples.slice(0, 3),
    longForm.buildLongFormQualitySampleFixture({ index: 99, rms: 0.00001 }),
]));
const shortCountFail = capture(() => longForm.assertLongFormMemoryAcceptanceReport({
    success: true,
    sentenceCount: 24,
    longFormQualityMeasured: true,
    longFormMosMeasured: false,
    longFormQualityDisclosure: longForm.LONG_FORM_QUALITY_MEASURED_NEEDLE,
    samples: qualitySamples,
}));
const finalizeMosClaimFail = capture(() =>
    longForm.finalizeLongFormMemoryAcceptanceReport({
        success: true,
        sentenceCount: longForm.LONG_FORM_SENTENCE_COUNT,
        longFormMosMeasured: true,
        samples: qualitySamples,
    }));
const finalizeNoSamplesFail = capture(() =>
    longForm.finalizeLongFormMemoryAcceptanceReport({
        success: true,
        sentenceCount: longForm.LONG_FORM_SENTENCE_COUNT,
    }));
const sampleGate = {
    first: longForm.shouldSampleLongFormWaveform(0, visits),
    mid: longForm.shouldSampleLongFormWaveform(6, visits),
    skip: longForm.shouldSampleLongFormWaveform(7, visits),
    lastVisit: longForm.shouldSampleLongFormWaveform(
        visits[visits.length - 1], visits),
};
console.log(JSON.stringify({
    sentenceCount: longForm.LONG_FORM_SENTENCE_COUNT,
    numberWordLen: longForm.LONG_FORM_NUMBER_WORDS.length,
    speechHead: speech.slice(0, 3),
    speechTail: speech.slice(-2),
    pendingLen: pending.length,
    pendingShape: pending[0],
    cfgKeys: Object.keys(cfg).sort(),
    seedsLocalTtsBackend: Object.hasOwn(cfg, 'ttsBackend'),
    probeArmed: cfg.pendingAcceptanceProbe === true,
    autoplayDisabled: cfg.pendingAutoplay === false,
    offlineApi: cfg.apiUrl === '' && cfg.pendingApiUrl === null,
    backend: cfg.pendingTtsBackend,
    visits,
    visitEndsOnLast: visits.includes(longForm.LONG_FORM_SENTENCE_COUNT - 1),
    stageTruthTable: {
        onnxOriginOk: longForm.originLongFormMemoryStageEnabled(true, 'onnx', true),
        mediapipeOriginOk: longForm.originLongFormMemoryStageEnabled(true, 'mediapipe', true),
        noOrigin: longForm.originLongFormMemoryStageEnabled(false, 'onnx', true),
        priorFailure: longForm.originLongFormMemoryStageEnabled(true, 'onnx', false),
        remoteBlocked: capture(() => longForm.requireLongFormBackend('remote')),
    },
    mediapipeStorage: (() => {
        const cfg = longForm.longFormStorageConfig('mediapipe');
        return {
            backend: cfg.pendingTtsBackend,
            probe: cfg.pendingAcceptanceProbe === true,
            variant: cfg.mediaPipeVariant,
        };
    })(),
    statsPass: capture(() => longForm.assertBoundedAudioManagerStats(sampleStats)),
    windowPass: capture(() => longForm.assertLongFormCacheWindowNear(sampleStats, 2)),
    windowFail: capture(() => longForm.assertLongFormCacheWindowNear(
        { ...sampleStats, window: { first: 10, last: 14 } }, 2)),
    statsCacheFail: capture(() => longForm.assertBoundedAudioManagerStats({
        ...sampleStats, cacheSize: longForm.LONG_FORM_MAX_CACHE_ENTRIES + 3,
    })),
    statsUrlFail: capture(() => longForm.assertBoundedAudioManagerStats({
        ...sampleStats, objectUrlCount: longForm.LONG_FORM_MAX_OBJECT_URLS + 3,
    })),
    heapPass: longForm.assertLongFormHeapDelta(50, 75),
    heapFail: capture(() => longForm.assertLongFormHeapDelta(0, 300 * 1024 * 1024)),
    mediapipeAccept: capture(() => longForm.requireLongFormBackend('mediapipe')),
    backends: [...longForm.ALLOWED_LONG_FORM_BACKENDS].sort(),
    bounds: {
        cache: longForm.LONG_FORM_MAX_CACHE_ENTRIES,
        urls: longForm.LONG_FORM_MAX_OBJECT_URLS,
    },
    measuredNeedle: longForm.LONG_FORM_QUALITY_MEASURED_NEEDLE,
    legacyNeedle: longForm.LONG_FORM_QUALITY_NOT_MEASURED_NEEDLE,
    sampleGate,
    finalized,
    qualityOffFail,
    mosClaimFail,
    silentFail,
    shortCountFail,
    finalizeMosClaimFail,
    finalizeNoSamplesFail,
}));
`], { encoding: 'utf8', cwd: root });
    return child;
}

describe('long-form memory acceptance', () => {
    test('helper snapshot covers document, probe storage, bounds, and quality', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.sentenceCount).toBe(36);
        expect(snap.numberWordLen).toBeGreaterThanOrEqual(36);
        expect(snap.pendingLen).toBe(36);
        expect(snap.speechHead).toEqual([
            'Hello one.', 'Hello two.', 'Hello three.',
        ]);
        expect(snap.speechTail).toEqual(['Hello score.', 'Hello pair.']);
        expect(snap.pendingShape).toEqual({ type: 'text', content: 'Hello one.' });
        expect(snap.backend).toBe('onnx');
        expect(snap.probeArmed).toBe(true);
        expect(snap.autoplayDisabled).toBe(true);
        expect(snap.offlineApi).toBe(true);
        expect(snap.cfgKeys).toEqual(expect.arrayContaining([
            'pendingAcceptanceProbe', 'pendingContent', 'pendingTtsBackend',
        ]));
        expect(snap.seedsLocalTtsBackend).toBe(false);
        expect(snap.visitEndsOnLast).toBe(false);
        expect(snap.visits[snap.visits.length - 1]).toBeLessThan(35);
        expect(snap.stageTruthTable.onnxOriginOk).toBe(true);
        expect(snap.stageTruthTable.mediapipeOriginOk).toBe(true);
        expect(snap.stageTruthTable.noOrigin).toBe(false);
        expect(snap.stageTruthTable.priorFailure).toBe(false);
        expect(snap.stageTruthTable.remoteBlocked.ok).toBe(false);
        expect(snap.mediapipeStorage).toEqual({
            backend: 'mediapipe', probe: true, variant: 'cpu',
        });
        expect(snap.statsPass).toEqual({ ok: true });
        expect(snap.windowPass).toEqual({ ok: true });
        expect(snap.windowFail.ok).toBe(false);
        expect(snap.statsCacheFail.ok).toBe(false);
        expect(snap.statsCacheFail.message).toMatch(/cache exceeded/);
        expect(snap.statsUrlFail.ok).toBe(false);
        expect(snap.statsUrlFail.message).toMatch(/object URLs exceeded/);
        expect(snap.heapPass.growth).toBe(25);
        expect(snap.heapFail.ok).toBe(false);
        expect(snap.heapFail.message).toMatch(/heap growth exceeded/);
        expect(snap.mediapipeAccept).toEqual({ ok: true });
        expect(snap.backends).toEqual(['mediapipe', 'onnx']);
        expect(snap.bounds).toEqual({ cache: 8, urls: 8 });
        expect(snap.measuredNeedle).toBe(
            'long-form objective waveform quality measured; MOS not measured');
        expect(snap.legacyNeedle).toBe(
            'deeper long-form quality/performance not measured');
        expect(snap.sampleGate).toEqual({
            first: true, mid: true, skip: false, lastVisit: true,
        });
        expect(snap.finalized.longFormQualityMeasured).toBe(true);
        expect(snap.finalized.longFormMosMeasured).toBe(false);
        expect(snap.finalized.longFormQualityDisclosure).toBe(snap.measuredNeedle);
        expect(snap.finalized.sentenceCount).toBe(36);
        expect(snap.finalized.qualitySampleCount).toBe(4);
        expect(snap.finalized.minRms).toBeGreaterThan(0.0001);
        expect(snap.qualityOffFail.ok).toBe(false);
        expect(snap.qualityOffFail.message).toMatch(/must be reported as measured/);
        expect(snap.mosClaimFail.ok).toBe(false);
        expect(snap.mosClaimFail.message).toMatch(/MOS must not/);
        expect(snap.silentFail.ok).toBe(false);
        expect(snap.silentFail.message).toMatch(/silent|RMS/i);
        expect(snap.shortCountFail.ok).toBe(false);
        expect(snap.shortCountFail.message).toMatch(/sentenceCount must be >=/);
        expect(snap.finalizeMosClaimFail.ok).toBe(false);
        expect(snap.finalizeMosClaimFail.message).toMatch(/MOS must not/);
        expect(snap.finalizeNoSamplesFail.ok).toBe(false);
        expect(snap.finalizeNoSamplesFail.message).toMatch(/quality requires/);
    });

    test('overlay probe and long-form stage are wired for Chromium origin', () => {
        const harness = fs.readFileSync(
            path.join(root, 'scripts', 'validate-live-chromium.mjs'), 'utf8');
        const overlay = fs.readFileSync(path.join(root, 'overlay.js'), 'utf8');
        expect(harness).toContain("from './long-form-memory-acceptance.mjs'");
        expect(harness).toContain('acceptLongFormMemoryPerformance');
        expect(harness).toContain('longFormMemoryAcceptance');
        expect(harness).toContain('offline-real-long-form-memory');
        expect(harness).toContain('long-form storage seed');
        expect(harness).toContain('seedLongFormOverlay');
        expect(harness).toContain('walkLongFormSentences');
        expect(harness).toContain('jumpLongFormAcrossWindows');
        expect(harness).toContain('readSyncTtsBackend');
        expect(harness).toContain('chrome.storage.sync.get');
        expect(harness).toContain('waitLongFormOverlayReady');
        expect(harness).toContain('({ idx, count })');
        expect(harness).toContain('count: LONG_FORM_SENTENCE_COUNT');
        expect(harness).toContain('finalizeLongFormMemoryAcceptanceReport');
        expect(harness).toContain('shouldSampleLongFormWaveform');
        expect(harness).toContain('sampleRateHz, rms, durationSec');
        expect(harness).not.toContain('waitForFunction(longFormOverlayReady');
        expect(harness).not.toContain('jumpLongFormToLastSentence');
        expect(overlay).toContain('pendingAcceptanceProbe');
        expect(overlay).toContain('syncAcceptanceProbe');
        expect(overlay).toContain('__kokoroAudioManagerStats');
        expect(overlay).toContain('appendOverlayRenderBlock');
        expect(overlay).toContain('audioManager.audioCache.size');
        expect(overlay).toContain('audioManager.objectUrls.size');
        const helper = fs.readFileSync(
            path.join(root, 'scripts', 'long-form-memory-acceptance.mjs'), 'utf8');
        expect(helper).toContain('LONG_FORM_SENTENCE_COUNT = 36');
        expect(helper).toContain('longFormQualityMeasured: true');
        expect(helper).toContain('longFormMosMeasured: false');
        expect(helper).toContain(
            'long-form objective waveform quality measured; MOS not measured');
        expect(helper).toContain('assertLongFormWaveformQuality');
        expect(helper).toContain('shouldSampleLongFormWaveform');
    });
});
