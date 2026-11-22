/**
 * Shared FastAPI / server-card live acceptance contract (#61 / KE-27).
 * Chromium imports this; Firefox loads asserts via Node for the same shapes.
 */

/**
 * ffprobe-valid silent mono MP3 (~0.13s, LAME). Generated once with:
 * ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 0.1 -q:a 9 -acodec libmp3lame
 * Do not shrink below a complete MPEG frame — truncated fixtures pass URL
 * prefix checks while remaining undecodable.
 */
export const MINIMAL_MP3_BASE64 =
    'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAFAAACvgBoaGhoaGhoaGhoaGhoaGhoaGhojo6Ojo6Ojo6Ojo6Ojo6Ojo6Ojo60tLS0tLS0tLS0tLS0tLS0tLS0tNra2tra2tra2tra2tra2tra2tra//////////////////////////8AAAAATGF2YzYwLjMxAAAAAAAAAAAAAAAAJAMGAAAAAAAAAr4QurGFAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMQpg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxFMDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDEfIPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMSmA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

export const MINIMAL_MP3_BYTES = Uint8Array.from(
    Buffer.from(MINIMAL_MP3_BASE64, 'base64'));

/**
 * Dual FastAPI stub timing: delay first body byte for TTFB, then hold a
 * playable prefix open long enough for muted MediaSource `playing` before EOF.
 * CI Chromium needed >250ms decode headroom on the short fixture.
 */
export const FASTAPI_STUB_FIRST_BYTE_DELAY_MS = 100;
export const FASTAPI_STUB_PROGRESSIVE_TAIL_HOLD_MS = 2000;
export const FASTAPI_STUB_PROGRESSIVE_TAIL_BYTES = 32;

/**
 * Split stub MP3 into playable prefix + delayed tail for progressive TTFA.
 * @param {Uint8Array|Buffer} body
 * @returns {{ first: Uint8Array, rest: Uint8Array }}
 */
export function splitFastApiStubMp3ForProgressive(body) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    const tailLen = Math.min(
        FASTAPI_STUB_PROGRESSIVE_TAIL_BYTES,
        Math.max(1, bytes.length - 1));
    const firstLen = Math.max(1, bytes.length - tailLen);
    return {
        first: bytes.subarray(0, firstLen),
        rest: bytes.subarray(firstLen),
    };
}

export const SERVER_PLAYABLE_MP3_NEEDLE = 'Server returned playable MP3';
export const SERVER_FIRST_BODY_BYTE_NEEDLE = 'First body byte (TTFB) p50';
export const SERVER_PLAYBACK_START_NEEDLE = 'playback start p50';
export const SERVER_NOT_MEDIASOURCE_NEEDLE = 'not MediaSource streaming TTFA';
/** Honesty needle: progressive MSE TTFA remains unmeasured (KE-41c / unavailable). */
export const SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE =
    'MediaSource progressive TTFA not measured';
/** Measured progressive MSE TTFA needle (leave-open measurement path). */
export const SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_MEASURED_NEEDLE =
    'progressive MediaSource TTFA measured';
export const SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_UNAVAILABLE_NEEDLE =
    'progressive MediaSource TTFA unavailable';
export const FASTAPI_SELECTED_NEEDLE = 'FastAPI selected.';
export const SERVER_STATUS_NOT_TESTED = 'Not tested';
/** Backend used to prove chooseServer writes (testFastApi needs fastapi first). */
export const BACKEND_BEFORE_CHOOSE = 'mediapipe';

/** Normalize apiUrl so `new URL('audio/speech', base)` matches Kokoro-FastAPI. */
export function normalizeFastApiBaseUrl(baseUrl) {
    const raw = String(baseUrl || '').trim();
    if (!raw) throw new Error('FastAPI base URL missing');
    const withSlash = raw.endsWith('/') ? raw : raw + '/';
    return withSlash;
}

/** Build speech endpoint from a configured /v1/ base (matches testFastApi). */
export function speechEndpointFromApiUrl(apiUrl) {
    const base = new URL(normalizeFastApiBaseUrl(apiUrl));
    return new URL('audio/speech', base.href).href;
}

function requireTrue(report, key, message) {
    if (report[key] !== true) throw new Error(message);
}

function assertFastApiCardAudio(report) {
    requireTrue(report, 'playableMp3Returned', 'playableMp3Returned must be true');
    requireTrue(report, 'decodeableMp3', 'decodeableMp3 must be true');
    if (!(report.mp3FixtureBytes > 400)) {
        throw new Error(
            'mp3FixtureBytes too small for a complete frame: ' +
            report.mp3FixtureBytes);
    }
    if (report.audioDataUrlPrefix !== 'data:audio') {
        throw new Error(
            'audioDataUrlPrefix mismatch: ' + report.audioDataUrlPrefix);
    }
}

function assertFastApiFirstBodyByte(report) {
    requireTrue(report, 'streamingFirstBodyByteMeasured',
        'streamingFirstBodyByteMeasured must be true for FastAPI TTFB');
    requireTrue(report, 'playbackStartMeasured',
        'playbackStartMeasured must be true (HTMLAudioElement after download)');
    if (report.playbackStartNotMeasured === true) {
        throw new Error(
            'playbackStartNotMeasured must not claim unmeasured when measured');
    }
    // HTMLAudioElement start is measured. Progressive MediaSource TTFA is either
    // measured with a real finite p50, or explicitly unavailable/unmeasured —
    // never invent MSE streaming TTFA numbers.
    assertFastApiMediaSourceProgressiveTtfa(report);
    if (!(Number.isFinite(report.firstBodyByteP50Ms) &&
        report.firstBodyByteP50Ms >= 0)) {
        throw new Error(
            'firstBodyByteP50Ms must be a finite nonnegative ms value: ' +
            report.firstBodyByteP50Ms);
    }
    // Dual stubs delay the first body chunk (~100ms). Full-buffer timing
    // (firstBodyByteMs === synthesisMs) must not pass as streamed TTFB.
    if (!(Number.isFinite(report.synthesisP50Ms) &&
        report.synthesisP50Ms > report.firstBodyByteP50Ms)) {
        throw new Error(
            'synthesisP50Ms must be strictly greater than firstBodyByteP50Ms ' +
            '(streamed first byte vs full response): ' +
            report.synthesisP50Ms + ' vs ' + report.firstBodyByteP50Ms);
    }
    if (!(report.firstBodyByteP50Ms >= 50)) {
        throw new Error(
            'firstBodyByteP50Ms must reflect the delayed first chunk (>=50ms): ' +
            report.firstBodyByteP50Ms);
    }
    if (!(Number.isFinite(report.playbackStartP50Ms) &&
        report.playbackStartP50Ms >= report.synthesisP50Ms)) {
        throw new Error(
            'playbackStartP50Ms must be at/after synthesisP50Ms ' +
            '(post-download start, not MediaSource): ' +
            report.playbackStartP50Ms + ' vs ' + report.synthesisP50Ms);
    }
}

/**
 * Parse observed progressive p50 from dataset raw (never Number('') → 0).
 * Empty string → NaN so measured asserts fail closed; finite leftovers on
 * unavailable paths stay visible to the invent check.
 * @param {unknown} p50Raw
 * @param {unknown} [p50Ms]
 * @returns {number|null}
 */
export function parseObservedProgressiveTtfaP50Ms(p50Raw, p50Ms) {
    if (p50Raw !== undefined && p50Raw !== null) {
        const trimmed = String(p50Raw).trim();
        if (trimmed === '') {
            // Blank raw must not hide an independently supplied finite p50
            // (invent checks on unavailable cards need to see it).
            if (Number.isFinite(p50Ms)) return p50Ms;
            return Number.NaN;
        }
        return Number(trimmed);
    }
    if (p50Ms === undefined) return null;
    return p50Ms;
}

function progressiveDisclosureLooksMeasured(disclosure) {
    const needle = disclosure.toLowerCase();
    return needle.includes('progressive') &&
        needle.includes('mediasource') &&
        needle.includes('ttfa') &&
        /\bmeasured\b/.test(needle) &&
        !needle.includes('not measured');
}

function progressiveDisclosureLooksHonesty(disclosure, unavailable) {
    const needle = disclosure.toLowerCase();
    if (unavailable) {
        return needle.includes('unavailable') ||
            disclosure === SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE;
    }
    return disclosure === SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE ||
        needle.includes('unavailable');
}

function assertMeasuredProgressiveTtfa(report, disclosure, p50Ms) {
    if (report.mediasourceProgressiveTtfaUnavailable === true) {
        throw new Error(
            'measured progressive MediaSource TTFA must not also claim unavailable');
    }
    if (report.mediasourceProgressiveTtfaNotMeasured === true) {
        throw new Error(
            'mediasourceProgressiveTtfaNotMeasured must be false when measured');
    }
    if (report.mediasourceProgressiveTtfaP50Raw != null &&
        String(report.mediasourceProgressiveTtfaP50Raw).trim() === '') {
        throw new Error(
            'empty mediasourceProgressiveTtfaP50Raw must not become 0');
    }
    if (!(Number.isFinite(p50Ms) && p50Ms >= 0)) {
        throw new Error(
            'mediasourceProgressiveTtfaP50Ms must be finite ms when measured: ' +
            p50Ms);
    }
    if (report.usedMediaSource !== true) {
        throw new Error('usedMediaSource must be true when MSE TTFA measured');
    }
    if (!progressiveDisclosureLooksMeasured(disclosure)) {
        throw new Error(
            'mediasourceProgressiveTtfaDisclosure must be measured needle: ' +
            disclosure);
    }
}

function assertUnmeasuredProgressiveTtfa(report, disclosure, p50Ms, unavailable) {
    requireTrue(report, 'mediasourceProgressiveTtfaNotMeasured',
        'mediasourceProgressiveTtfaNotMeasured must be true when unmeasured');
    // Do not discard leftover p50Raw on unavailable — invent check must see it.
    const raw = report.mediasourceProgressiveTtfaP50Raw;
    if ((raw != null && String(raw).trim() !== '') || Number.isFinite(p50Ms)) {
        throw new Error(
            'unmeasured/unavailable MediaSource TTFA must not invent p50 ms: ' +
            (Number.isFinite(p50Ms) ? p50Ms : raw));
    }
    if (!progressiveDisclosureLooksHonesty(disclosure, unavailable)) {
        throw new Error(
            'mediasourceProgressiveTtfaDisclosure must be honesty/unavailable: ' +
            disclosure);
    }
}

/** Nested helpers keep CodeFactor method complexity under the gate. */
function assertFastApiMediaSourceProgressiveTtfa(report) {
    const measured = report.mediasourceProgressiveTtfaMeasured;
    const unavailable = report.mediasourceProgressiveTtfaUnavailable === true;
    const disclosure = String(
        report.mediasourceProgressiveTtfaDisclosure || '');
    const p50Ms = parseObservedProgressiveTtfaP50Ms(
        report.mediasourceProgressiveTtfaP50Raw,
        report.mediasourceProgressiveTtfaP50Ms);
    if (measured === true) {
        assertMeasuredProgressiveTtfa(report, disclosure, p50Ms);
        return;
    }
    if (measured !== false) {
        throw new Error(
            'mediasourceProgressiveTtfaMeasured must be true or false: ' +
            measured);
    }
    assertUnmeasuredProgressiveTtfa(report, disclosure, p50Ms, unavailable);
}

function assertFastApiCardChoose(report) {
    requireTrue(report, 'chooseServerEnabledAfterTest',
        'chooseServer must enable after a successful test');
    if (report.backendBeforeChoose !== BACKEND_BEFORE_CHOOSE) {
        throw new Error(
            'backendBeforeChoose must be ' + BACKEND_BEFORE_CHOOSE + ': ' +
            report.backendBeforeChoose);
    }
    requireTrue(report, 'chooseChangedBackend',
        'chooseChangedBackend must be true');
    if (report.selectedBackend !== 'fastapi') {
        throw new Error(
            'selectedBackend must be fastapi: ' + report.selectedBackend);
    }
    requireTrue(report, 'preferenceOnlyOnChoose',
        'preferenceOnlyOnChoose must be true');
}

function assertFastApiCardEndpoints(report) {
    if (!String(report.apiUrl || '').includes('/v1')) {
        throw new Error('apiUrl must point at a /v1 FastAPI base');
    }
    if (!String(report.speechEndpoint || '').includes('audio/speech')) {
        throw new Error('speechEndpoint must target audio/speech');
    }
}

/**
 * Validate a dual-scope FastAPI card acceptance report before saving.
 * Distinct keys from dual-use-this-backend / popup-cta reports (Sonar).
 * Nested helpers keep CodeFactor method complexity under the gate.
 */
export function assertFastApiServerCardReport(report) {
    if (!report || typeof report !== 'object') {
        throw new Error('FastAPI server-card report missing: ' + String(report));
    }
    requireTrue(report, 'success', 'FastAPI server-card report not successful');
    requireTrue(report, 'serverCardTested', 'serverCardTested must be true');
    assertFastApiCardAudio(report);
    assertFastApiFirstBodyByte(report);
    assertFastApiCardChoose(report);
    assertFastApiCardEndpoints(report);
    return true;
}

export function buildFastApiServerCardReport(options = {}) {
    const apiUrl = normalizeFastApiBaseUrl(
        options.apiUrl || 'http://127.0.0.1:0/v1/');
    const firstBodyByteP50Ms = Number.isFinite(options.firstBodyByteP50Ms)
        ? options.firstBodyByteP50Ms : 110;
    const synthesisP50Ms = Number.isFinite(options.synthesisP50Ms)
        ? options.synthesisP50Ms : Math.max(firstBodyByteP50Ms + 40, 160);
    const playbackStartP50Ms = Number.isFinite(options.playbackStartP50Ms)
        ? options.playbackStartP50Ms : Math.max(synthesisP50Ms + 20, 200);
    const report = {
        success: true,
        browser: options.browser || 'unknown',
        serverCardTested: true,
        playableMp3Returned: true,
        decodeableMp3: options.decodeableMp3 !== false,
        mp3FixtureBytes: MINIMAL_MP3_BYTES.length,
        audioDataUrlPrefix: 'data:audio',
        streamingFirstBodyByteMeasured:
            options.streamingFirstBodyByteMeasured !== false,
        playbackStartMeasured: options.playbackStartMeasured !== false,
        playbackStartNotMeasured: false,
        // Unit-test / stub defaults when keys are omitted. Live Chromium+Firefox
        // must pass values observed from the page (dataset + status text).
        mediasourceProgressiveTtfaMeasured:
            Object.prototype.hasOwnProperty.call(
                options, 'mediasourceProgressiveTtfaMeasured')
                ? options.mediasourceProgressiveTtfaMeasured
                : false,
        mediasourceProgressiveTtfaNotMeasured:
            Object.prototype.hasOwnProperty.call(
                options, 'mediasourceProgressiveTtfaNotMeasured')
                ? options.mediasourceProgressiveTtfaNotMeasured === true
                : true,
        mediasourceProgressiveTtfaUnavailable:
            options.mediasourceProgressiveTtfaUnavailable === true,
        mediasourceProgressiveTtfaP50Raw:
            Object.prototype.hasOwnProperty.call(
                options, 'mediasourceProgressiveTtfaP50Raw')
                ? options.mediasourceProgressiveTtfaP50Raw
                : undefined,
        mediasourceProgressiveTtfaP50Ms: parseObservedProgressiveTtfaP50Ms(
            Object.prototype.hasOwnProperty.call(
                options, 'mediasourceProgressiveTtfaP50Raw')
                ? options.mediasourceProgressiveTtfaP50Raw
                : undefined,
            Object.prototype.hasOwnProperty.call(
                options, 'mediasourceProgressiveTtfaP50Ms')
                ? options.mediasourceProgressiveTtfaP50Ms
                : null),
        usedMediaSource: options.usedMediaSource === true,
        mediasourceProgressiveTtfaDisclosure:
            Object.prototype.hasOwnProperty.call(
                options, 'mediasourceProgressiveTtfaDisclosure')
                ? String(options.mediasourceProgressiveTtfaDisclosure || '')
                : SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE,
        firstBodyByteP50Ms,
        synthesisP50Ms,
        playbackStartP50Ms,
        chooseServerEnabledAfterTest: true,
        backendBeforeChoose: options.backendBeforeChoose || BACKEND_BEFORE_CHOOSE,
        chooseChangedBackend: options.chooseChangedBackend !== false,
        preferenceOnlyOnChoose: true,
        selectedBackend: 'fastapi',
        fastapiSelectedStatus: true,
        loopbackStub: true,
        apiUrl,
        speechEndpoint: speechEndpointFromApiUrl(apiUrl),
        afterLocalDualComparison: options.afterLocalDualComparison !== false,
        audioDurationSec: options.audioDurationSec || null,
    };
    assertFastApiServerCardReport(report);
    return report;
}
