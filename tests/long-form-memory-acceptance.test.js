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
        index: 35, rms: 0.045, audioBytes: 48000, durationSec: 1,
    }),
];
const capture = (fn) => {
    try { fn(); return { ok: true }; }
    catch (error) { return { ok: false, message: String(error.message || error) }; }
};
// Real WAV bytes → shared PCM16 decoder (Devin: exercise decoder path).
const wavBytes = longForm.buildLongFormTestWavPcm16(24000);
const decoded = longForm.decodeLongFormWavPcm16Metrics(wavBytes);
const silentMetrics = longForm.decodeLongFormWavPcm16Metrics(
    longForm.buildLongFormTestWavPcm16(24000, { amplitude: 0 }));
const silentAssertFail = capture(() => longForm.assertLongFormWaveformSample({
    index: 0, ...silentMetrics, audioSha256: 'silent',
}));
const badHeader = capture(() => longForm.decodeLongFormWavPcm16Metrics(
    new Uint8Array(64)));
// Mutate a valid PCM16 mono header; each must fail closed (CR P2).
const mutateWav = (fn) => {
    const copy = new Uint8Array(wavBytes);
    fn(new DataView(copy.buffer), copy);
    return capture(() => longForm.decodeLongFormWavPcm16Metrics(copy));
};
const textAt = (view, offset, value) => {
    for (let i = 0; i < value.length; i++) {
        view.setUint8(offset + i, value.charCodeAt(i));
    }
};
const badFmtTag = mutateWav((view) => textAt(view, 12, 'JUNK'));
const badFmtChunkSize = mutateWav((view) => view.setUint32(16, 18, true));
const badFloatFormat = mutateWav((view) => view.setUint16(20, 3, true));
const badStereo = mutateWav((view) => view.setUint16(22, 2, true));
const badByteRate = mutateWav((view) => view.setUint32(28, 96000, true));
const badBits8 = mutateWav((view) => view.setUint16(34, 8, true));
const badDataTag = mutateWav((view) => textAt(view, 36, 'JUNK'));
const badBlockAlign = mutateWav((view) => view.setUint16(32, 4, true));
const badRiffSize = mutateWav((view) => view.setUint32(4, 99, true));
// Distinct-index gate: four copies of index 0 must not pad the minimum.
const repeatPadFail = capture(() => longForm.assertLongFormWaveformQuality([
    longForm.buildLongFormQualitySampleFixture({ index: 0, rms: 0.03 }),
    longForm.buildLongFormQualitySampleFixture({ index: 0, rms: 0.04 }),
    longForm.buildLongFormQualitySampleFixture({ index: 0, rms: 0.05 }),
    longForm.buildLongFormQualitySampleFixture({ index: 0, rms: 0.06 }),
]));
// Revisit of index 0 supplies RMS + duration extrema without raising distinct count.
const withRevisitExtreme = longForm.assertLongFormWaveformQuality([
    ...qualitySamples,
    longForm.buildLongFormQualitySampleFixture({
        index: 0, rms: 0.001, audioBytes: 24000, durationSec: 0.5,
    }),
]);
const durationMismatchFail = capture(() => longForm.assertLongFormWaveformSample(
    longForm.buildLongFormQualitySampleFixture({
        index: 1, audioBytes: 48000, durationSec: 1.2,
    })));
// Tone RMS ≈ amplitude / √2 (PCM16 quantization tolerance).
const expectedToneRms = 0.25 / Math.SQRT2;
const toneRmsClose = Math.abs(decoded.rms - expectedToneRms) < 0.002;
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
    decoded: {
        audioBytes: decoded.audioBytes,
        sampleRateHz: decoded.sampleRateHz,
        durationSec: decoded.durationSec,
        sampleCount: decoded.sampleCount,
        rmsFinite: Number.isFinite(decoded.rms),
        rmsAboveFloor: decoded.rms > longForm.LONG_FORM_MIN_RMS,
        toneRmsClose,
        expectedToneRms,
        decodedRms: decoded.rms,
        wavByteLength: wavBytes.length,
        // 48_000 PCM bytes ⇒ 1.0 s at 24 kHz mono PCM16 (not 1.2 s).
        oneSecond: decoded.audioBytes === 48000 && decoded.durationSec === 1,
    },
    silentMetrics: {
        durationSec: silentMetrics.durationSec,
        audioBytes: silentMetrics.audioBytes,
        rmsNearZero: silentMetrics.rms <= longForm.LONG_FORM_MIN_RMS,
    },
    silentAssertFail,
    badHeader,
    wavFormatFails: {
        badFmtTag, badFmtChunkSize, badFloatFormat, badStereo, badByteRate,
        badBits8, badDataTag, badBlockAlign, badRiffSize,
    },
    repeatPadFail,
    withRevisitExtreme: {
        distinctCount: withRevisitExtreme.qualitySampleCount,
        validatedProbeCount: withRevisitExtreme.validatedProbeCount,
        distinctSentenceIndexes: withRevisitExtreme.distinctSentenceIndexes,
        minRms: withRevisitExtreme.minRms,
        maxRms: withRevisitExtreme.maxRms,
        minDurationSec: withRevisitExtreme.minDurationSec,
        maxDurationSec: withRevisitExtreme.maxDurationSec,
    },
    durationMismatchFail,
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
        expect(snap.finalized.validatedProbeCount).toBe(4);
        expect(snap.finalized.distinctSentenceIndexes).toEqual([0, 6, 12, 35]);
        expect(snap.finalized.minRms).toBeGreaterThan(0.0001);
        expect(snap.decoded.oneSecond).toBe(true);
        expect(snap.decoded.sampleRateHz).toBe(24000);
        expect(snap.decoded.sampleCount).toBe(24000);
        expect(snap.decoded.rmsAboveFloor).toBe(true);
        expect(snap.decoded.toneRmsClose).toBe(true);
        expect(snap.decoded.wavByteLength).toBe(44 + 48000);
        expect(snap.silentMetrics.rmsNearZero).toBe(true);
        expect(snap.silentMetrics.durationSec).toBe(1);
        expect(snap.silentAssertFail.ok).toBe(false);
        expect(snap.silentAssertFail.message).toMatch(/silent|RMS/i);
        expect(snap.badHeader.ok).toBe(false);
        expect(snap.badHeader.message).toMatch(/WAV/i);
        for (const [name, fail] of Object.entries(snap.wavFormatFails)) {
            expect({ name, ...fail }).toEqual(expect.objectContaining({
                name, ok: false,
            }));
            expect(fail.message).toMatch(/WAV mismatch/i);
        }
        expect(Object.keys(snap.wavFormatFails)).toEqual([
            'badFmtTag', 'badFmtChunkSize', 'badFloatFormat', 'badStereo',
            'badByteRate', 'badBits8', 'badDataTag', 'badBlockAlign',
            'badRiffSize',
        ]);
        expect(snap.repeatPadFail.ok).toBe(false);
        expect(snap.repeatPadFail.message).toMatch(/distinct sentence positions/);
        expect(snap.withRevisitExtreme).toEqual({
            distinctCount: 4,
            validatedProbeCount: 5,
            distinctSentenceIndexes: [0, 6, 12, 35],
            minRms: 0.001,
            maxRms: 0.05,
            minDurationSec: 0.5,
            maxDurationSec: 1,
        });
        expect(snap.durationMismatchFail.ok).toBe(false);
        expect(snap.durationMismatchFail.message).toMatch(/duration must match/);
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
        expect(snap.finalizeNoSamplesFail.message).toMatch(
            /distinct sentence positions|quality requires/);
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
        expect(harness).toContain('decodeLongFormWavPcm16Metrics');
        expect(harness).toContain('wavBase64');
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
        expect(helper).toContain('decodeLongFormWavPcm16Metrics');
        expect(helper).toContain('buildLongFormTestWavPcm16');
        expect(helper).toContain('distinct sentence positions');
    });
});
