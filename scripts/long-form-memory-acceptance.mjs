/**
 * Shared long-form memory/performance live-acceptance helpers (Chromium +
 * Firefox origin; onnx + mediapipe). Speech tokens are short English number
 * words (CMUdict-friendly for ONNX q8; plain text for MediaPipe CPU).
 *
 * KE-52 / #57: deeper walk (36 sentences) stays memory-bound.
 * Leave-open after #183: objective waveform quality (PCM RMS / duration) is
 * measured on sampled long-form clips; subjective MOS remains unmeasured.
 */

export const LONG_FORM_SENTENCE_COUNT = 36;

/** Steady-state retainWindow(center, 2, 2) holds at most five indices; allow
 *  brief transition slack while the active source is replaced and prefetched. */
export const LONG_FORM_MAX_CACHE_ENTRIES = 8;
export const LONG_FORM_MAX_OBJECT_URLS = 8;

/** Minimum distinct WAV probes with finite non-silent RMS for quality gate. */
export const LONG_FORM_MIN_QUALITY_SAMPLES = 4;

/** Align with pcm-wav.js near-silence floor. */
export const LONG_FORM_MIN_RMS = 0.0001;
export const LONG_FORM_MIN_DURATION_SEC = 0.05;
export const LONG_FORM_MAX_DURATION_SEC = 30;

export const LONG_FORM_NUMBER_WORDS = Object.freeze([
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
    'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
    'million', 'billion', 'trillion', 'zero', 'dozen', 'score', 'pair',
]);

/** Legacy KE-52 honesty needle (superseded by measured objective quality). */
export const LONG_FORM_QUALITY_NOT_MEASURED_NEEDLE =
    'deeper long-form quality/performance not measured';

/** Disclosure when objective PCM quality was measured; MOS still unmeasured. */
export const LONG_FORM_QUALITY_MEASURED_NEEDLE =
    'long-form objective waveform quality measured; MOS not measured';

export const ALLOWED_LONG_FORM_BACKENDS = Object.freeze(['onnx', 'mediapipe']);

export function requireLongFormBackend(backend) {
    if (!ALLOWED_LONG_FORM_BACKENDS.includes(backend)) {
        throw new Error(
            'Long-form memory acceptance requires onnx or mediapipe backend, got: ' +
            String(backend));
    }
    return backend;
}

export function originLongFormMemoryStageEnabled(originDownload, provider, success) {
    return Boolean(
        originDownload &&
        ALLOWED_LONG_FORM_BACKENDS.includes(provider) &&
        success);
}

export function buildLongFormSpeechLines() {
    if (LONG_FORM_NUMBER_WORDS.length < LONG_FORM_SENTENCE_COUNT) {
        throw new Error('LONG_FORM_NUMBER_WORDS shorter than LONG_FORM_SENTENCE_COUNT');
    }
    return LONG_FORM_NUMBER_WORDS.slice(0, LONG_FORM_SENTENCE_COUNT)
        .map(word => 'Hello ' + word + '.');
}

export function buildLongFormPendingContent() {
    return buildLongFormSpeechLines().map(content => ({ type: 'text', content }));
}

export function longFormStorageConfig(backend) {
    requireLongFormBackend(backend);
    const lines = buildLongFormSpeechLines();
    // Pending overlay session only — never write sync user preference
    // (`ttsBackend`) into local; that belongs to chrome.storage.sync.
    return {
        pendingTtsBackend: backend,
        pendingApiUrl: null,
        pendingText: lines.join(' '),
        pendingContent: buildLongFormPendingContent(),
        pendingTitle: 'Kokoro long-form memory acceptance',
        pendingAutoplay: false,
        pendingAcceptanceProbe: true,
        apiUrl: '',
        mode: 'stream',
        mediaPipeVariant: 'cpu',
        localVoice: 'af_heart',
    };
}

/** Visit path must not already end on the last sentence — distant jump
 *  needs a real window change (return to 0, then seek to last). */
export function buildLongFormVisitIndexes(sentenceCount = LONG_FORM_SENTENCE_COUNT) {
    return Array.from({ length: sentenceCount }, (_, i) => i)
        .filter((i) => i < 8 || (i % 3 === 0 && i < sentenceCount - 1));
}

/**
 * Sparse WAV probes during the walk: first, last visit, and every 6th index.
 * Jump path adds return-to-0 + distant-last separately.
 */
export function shouldSampleLongFormWaveform(index, visitIndexes) {
    if (!Array.isArray(visitIndexes) || visitIndexes.length === 0) {
        throw new Error('visitIndexes required for long-form quality sampling');
    }
    if (index === 0) return true;
    if (index === visitIndexes[visitIndexes.length - 1]) return true;
    return index > 0 && index % 6 === 0;
}

export function assertLongFormCacheWindowNear(stats, center, options = {}) {
    const behind = options.behind ?? 2;
    const ahead = options.ahead ?? 2;
    if (!stats?.window ||
        !Number.isInteger(stats.window.first) ||
        !Number.isInteger(stats.window.last)) {
        throw new Error('Cache window missing after navigation: ' + JSON.stringify(stats));
    }
    if (stats.window.first > center || stats.window.last < center) {
        throw new Error('Cache window does not cover active sentence: ' +
            JSON.stringify({ center, window: stats.window, behind, ahead }));
    }
    if (stats.window.last - stats.window.first > behind + ahead) {
        throw new Error('Cache window wider than retainWindow bound: ' +
            JSON.stringify({ window: stats.window, behind, ahead }));
    }
    return true;
}

export function assertBoundedAudioManagerStats(stats, options = {}) {
    const maxCache = options.maxCacheEntries ?? LONG_FORM_MAX_CACHE_ENTRIES;
    const maxUrls = options.maxObjectUrls ?? LONG_FORM_MAX_OBJECT_URLS;
    const minSentences = options.minSentences ?? LONG_FORM_SENTENCE_COUNT;
    if (!stats || typeof stats !== 'object') {
        throw new Error('AudioManager acceptance probe missing: ' + String(stats));
    }
    if (!Number.isInteger(stats.sentenceCount) || stats.sentenceCount < minSentences) {
        throw new Error('Long-form sentence count too small: ' + JSON.stringify(stats));
    }
    if (!Number.isInteger(stats.cacheSize) || stats.cacheSize > maxCache) {
        throw new Error('AudioManager cache exceeded bound: ' + JSON.stringify({
            cacheSize: stats.cacheSize, maxCache, stats,
        }));
    }
    if (!Number.isInteger(stats.objectUrlCount) || stats.objectUrlCount > maxUrls) {
        throw new Error('AudioManager object URLs exceeded bound: ' + JSON.stringify({
            objectUrlCount: stats.objectUrlCount, maxUrls, stats,
        }));
    }
    return true;
}

export function assertLongFormHeapDelta(beforeBytes, afterBytes, options = {}) {
    const maxGrowthBytes = options.maxGrowthBytes ?? 256 * 1024 * 1024;
    if (!Number.isFinite(beforeBytes) || !Number.isFinite(afterBytes)) {
        throw new Error('Heap samples missing: ' + JSON.stringify({ beforeBytes, afterBytes }));
    }
    const growth = afterBytes - beforeBytes;
    if (growth > maxGrowthBytes) {
        throw new Error('Long-form JS heap growth exceeded bound: ' + JSON.stringify({
            beforeBytes, afterBytes, growth, maxGrowthBytes,
        }));
    }
    return { growth, maxGrowthBytes };
}

/**
 * Fixture sample for Jest — mirrors live WAV meta after PCM16 RMS decode.
 * Default 48_000 PCM bytes = 24_000 mono PCM16 samples = 1.0 s at 24 kHz.
 */
export function buildLongFormQualitySampleFixture(overrides = {}) {
    return {
        index: 0,
        audioBytes: 48000,
        sampleRateHz: 24000,
        durationSec: 1,
        rms: 0.04,
        audioSha256: 'fixture-sha256',
        ...overrides,
    };
}

/**
 * Build a minimal 24 kHz mono PCM16 RIFF/WAVE for Jest decode coverage.
 * amplitude 0 → near-silent; default produces non-silent 440 Hz tone.
 *
 * @param {number} sampleCount
 * @param {{ amplitude?: number }} [options]
 * @returns {Uint8Array}
 */
export function buildLongFormTestWavPcm16(sampleCount = 24000, options = {}) {
    const amplitude = options.amplitude ?? 0.25;
    if (!Number.isInteger(sampleCount) || sampleCount < 1) {
        throw new Error('sampleCount must be a positive integer');
    }
    const audioBytes = sampleCount * 2;
    const bytes = new Uint8Array(44 + audioBytes);
    const view = new DataView(bytes.buffer);
    const text = (offset, value) => {
        for (let i = 0; i < value.length; i++) {
            view.setUint8(offset + i, value.charCodeAt(i));
        }
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + audioBytes, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 24000, true);
    view.setUint32(28, 48000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, audioBytes, true);
    for (let i = 0; i < sampleCount; i++) {
        const s = amplitude * Math.sin((2 * Math.PI * 440 * i) / 24000);
        const clamped = Math.max(-1, Math.min(1, s));
        view.setInt16(
            44 + i * 2,
            Math.round(clamped * (clamped < 0 ? 32768 : 32767)),
            true);
    }
    return bytes;
}

/**
 * Decode a RIFF/WAVE 24 kHz mono PCM16 buffer into quality metrics.
 * Shared by Jest + Chromium/Firefox live (after transferring WAV bytes out of
 * the page). Fail closed on header mismatch / non-finite samples — never invent.
 *
 * @param {Uint8Array|ArrayBuffer} wavBytes
 * @returns {{ audioBytes, sampleRateHz, rms, durationSec, sampleCount }}
 */
export function decodeLongFormWavPcm16Metrics(wavBytes) {
    const bytes = wavBytes instanceof Uint8Array
        ? wavBytes
        : new Uint8Array(wavBytes);
    if (bytes.byteLength < 44) {
        throw new Error('Long-form WAV too short for header: ' + bytes.byteLength);
    }
    const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (start, length) =>
        String.fromCharCode(...bytes.subarray(start, start + length));
    const sampleRateHz = wav.getUint32(24, true);
    const audioBytes = wav.getUint32(40, true);
    if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE' ||
        sampleRateHz !== 24000 || audioBytes < 2 ||
        bytes.length !== 44 + audioBytes || audioBytes % 2 !== 0) {
        throw new Error('Long-form overlay WAV mismatch');
    }
    const sampleCount = audioBytes / 2;
    let squares = 0;
    for (let i = 0; i < sampleCount; i++) {
        const s = wav.getInt16(44 + i * 2, true) / 32768;
        if (!Number.isFinite(s)) {
            throw new Error('Long-form WAV sample not finite at ' + i);
        }
        squares += s * s;
    }
    const rms = Math.sqrt(squares / sampleCount);
    const durationSec = sampleCount / sampleRateHz;
    return { audioBytes, sampleRateHz, rms, durationSec, sampleCount };
}

/**
 * Assert one long-form WAV probe has finite non-silent 24 kHz PCM metrics.
 * Fail closed on missing/silent/out-of-bounds — never invent RMS.
 */
export function assertLongFormWaveformSample(sample) {
    if (!sample || typeof sample !== 'object') {
        throw new Error('Long-form quality sample missing: ' + String(sample));
    }
    if (!Number.isInteger(sample.index) || sample.index < 0) {
        throw new Error(
            'Long-form quality sample requires non-negative integer index: ' +
            JSON.stringify(sample));
    }
    if (sample.sampleRateHz !== 24000) {
        throw new Error(
            'Long-form quality sample must be 24 kHz: ' + JSON.stringify(sample));
    }
    if (!Number.isFinite(sample.rms) || sample.rms <= LONG_FORM_MIN_RMS) {
        throw new Error(
            'Long-form quality sample silent or missing RMS: ' +
            JSON.stringify(sample));
    }
    if (!Number.isFinite(sample.durationSec) ||
        sample.durationSec < LONG_FORM_MIN_DURATION_SEC ||
        sample.durationSec > LONG_FORM_MAX_DURATION_SEC) {
        throw new Error(
            'Long-form quality sample duration out of bounds: ' +
            JSON.stringify(sample));
    }
    if (!Number.isInteger(sample.audioBytes) || sample.audioBytes < 2 ||
        sample.audioBytes % 2 !== 0) {
        throw new Error(
            'Long-form quality sample audioBytes invalid: ' +
            JSON.stringify(sample));
    }
    const expectedDuration = (sample.audioBytes / 2) / sample.sampleRateHz;
    if (Math.abs(sample.durationSec - expectedDuration) > 1e-9) {
        throw new Error(
            'Long-form quality sample duration must match audioBytes/rate: ' +
            JSON.stringify({
                durationSec: sample.durationSec, expectedDuration,
                audioBytes: sample.audioBytes,
            }));
    }
    return {
        index: sample.index,
        rms: sample.rms,
        durationSec: sample.durationSec,
        sampleRateHz: sample.sampleRateHz,
        audioBytes: sample.audioBytes,
    };
}

/**
 * Assert objective waveform quality across sampled long-form clips.
 * Counts distinct sentence indexes only — revisit/copies of the same position
 * cannot pad the minimum probe count.
 * @returns {{ qualitySampleCount, distinctSentenceIndexes, minRms, maxRms,
 *   minDurationSec, maxDurationSec }}
 */
export function assertLongFormWaveformQuality(samples, options = {}) {
    const minSamples = options.minSamples ?? LONG_FORM_MIN_QUALITY_SAMPLES;
    if (!Array.isArray(samples)) {
        throw new Error(
            'Long-form quality requires a samples array; got ' +
            JSON.stringify(samples));
    }
    const byIndex = new Map();
    for (const sample of samples) {
        const checked = assertLongFormWaveformSample(sample);
        if (!byIndex.has(checked.index)) {
            byIndex.set(checked.index, checked);
        }
    }
    if (byIndex.size < minSamples) {
        throw new Error(
            'Long-form quality requires >= ' + minSamples +
            ' distinct sentence positions; got ' + byIndex.size +
            ' (raw probes: ' + samples.length + ')');
    }
    const checked = [...byIndex.values()];
    const rmsValues = checked.map((s) => s.rms);
    const durations = checked.map((s) => s.durationSec);
    return {
        qualitySampleCount: checked.length,
        distinctSentenceIndexes: [...byIndex.keys()].sort((a, b) => a - b),
        minRms: Math.min(...rmsValues),
        maxRms: Math.max(...rmsValues),
        minDurationSec: Math.min(...durations),
        maxDurationSec: Math.max(...durations),
    };
}

/**
 * MOS stays unmeasured; objective quality flags are set by finalize after
 * waveform asserts — do not invent measured:true without samples.
 */
export function longFormQualityDisclosureFlags() {
    return {
        longFormQualityMeasured: false,
        longFormMosMeasured: false,
        longFormQualityDisclosure: LONG_FORM_QUALITY_NOT_MEASURED_NEEDLE,
    };
}

function assertMosUnmeasured(report) {
    if (report.longFormMosMeasured !== false) {
        throw new Error(
            'Long-form MOS must not be reported as measured: ' +
            JSON.stringify(report.longFormMosMeasured));
    }
}

function assertMeasuredQualityDisclosure(report) {
    const disclosure = String(report.longFormQualityDisclosure || '').toLowerCase();
    if (!disclosure.includes('long-form objective waveform quality measured') ||
        !disclosure.includes('mos not measured')) {
        throw new Error(
            'Long-form quality measured disclosure needle missing: ' +
            JSON.stringify(report.longFormQualityDisclosure));
    }
}

/**
 * Assert memory-bound long-form report + objective waveform quality measured
 * (fail closed). MOS remains explicitly unmeasured.
 */
export function assertLongFormMemoryAcceptanceReport(report) {
    if (!report || typeof report !== 'object') {
        throw new Error('Long-form memory acceptance report missing');
    }
    if (report.success !== true) {
        throw new Error('Long-form memory acceptance not successful: ' +
            JSON.stringify(report));
    }
    if (!Number.isInteger(report.sentenceCount) ||
            report.sentenceCount < LONG_FORM_SENTENCE_COUNT) {
        throw new Error(
            'Long-form report sentenceCount must be >= ' +
            LONG_FORM_SENTENCE_COUNT + ': ' + JSON.stringify(report.sentenceCount));
    }
    assertMosUnmeasured(report);
    if (report.longFormQualityMeasured !== true) {
        throw new Error(
            'Long-form objective waveform quality must be reported as measured: ' +
            JSON.stringify(report.longFormQualityMeasured));
    }
    const quality = assertLongFormWaveformQuality(report.samples);
    assertMeasuredQualityDisclosure(report);
    return {
        success: true,
        sentenceCount: report.sentenceCount,
        longFormQualityMeasured: true,
        longFormMosMeasured: false,
        longFormQualityDisclosure: LONG_FORM_QUALITY_MEASURED_NEEDLE,
        ...quality,
    };
}

/**
 * Finalize a live long-form report: measure objective waveform quality from
 * samples, keep MOS unmeasured, fail closed if samples missing/silent or MOS
 * claimed. Does not invent RMS numbers.
 */
export function finalizeLongFormMemoryAcceptanceReport(partial = {}) {
    const report = {
        ...partial,
        sentenceCount: partial.sentenceCount ?? LONG_FORM_SENTENCE_COUNT,
    };
    if (report.longFormMosMeasured === undefined) {
        report.longFormMosMeasured = false;
    }
    // Fail closed before overwriting: MOS claim true must reject.
    assertMosUnmeasured(report);

    const quality = assertLongFormWaveformQuality(report.samples);
    report.longFormQualityMeasured = true;
    report.longFormMosMeasured = false;
    report.longFormQualityDisclosure = LONG_FORM_QUALITY_MEASURED_NEEDLE;
    report.qualitySampleCount = quality.qualitySampleCount;
    report.minRms = quality.minRms;
    report.maxRms = quality.maxRms;
    report.minDurationSec = quality.minDurationSec;
    report.maxDurationSec = quality.maxDurationSec;

    assertLongFormMemoryAcceptanceReport(report);
    return report;
}
