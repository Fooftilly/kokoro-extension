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

export const SERVER_PLAYABLE_MP3_NEEDLE = 'Server returned playable MP3';
export const SERVER_STREAMING_TTFA_NEEDLE = 'Streaming TTFA p50';
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

function assertFastApiStreamingTtfa(report) {
    requireTrue(report, 'streamingTtfaMeasured',
        'streamingTtfaMeasured must be true for FastAPI stream TTFA');
    if (!(Number.isFinite(report.firstAudioP50Ms) &&
        report.firstAudioP50Ms >= 0)) {
        throw new Error(
            'firstAudioP50Ms must be a finite nonnegative ms value: ' +
            report.firstAudioP50Ms);
    }
    // Dual stubs delay the first body chunk (~100ms). Full-buffer TTFA
    // (firstAudioMs === synthesisMs) must not pass as "streaming".
    if (!(Number.isFinite(report.synthesisP50Ms) &&
        report.synthesisP50Ms > report.firstAudioP50Ms)) {
        throw new Error(
            'synthesisP50Ms must be strictly greater than firstAudioP50Ms ' +
            '(streamed first byte vs full response): ' +
            report.synthesisP50Ms + ' vs ' + report.firstAudioP50Ms);
    }
    if (!(report.firstAudioP50Ms >= 50)) {
        throw new Error(
            'firstAudioP50Ms must reflect the delayed first chunk (>=50ms): ' +
            report.firstAudioP50Ms);
    }
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
    assertFastApiStreamingTtfa(report);
    assertFastApiCardChoose(report);
    assertFastApiCardEndpoints(report);
    return true;
}

export function buildFastApiServerCardReport(options = {}) {
    const apiUrl = normalizeFastApiBaseUrl(
        options.apiUrl || 'http://127.0.0.1:0/v1/');
    const firstAudioP50Ms = Number.isFinite(options.firstAudioP50Ms)
        ? options.firstAudioP50Ms : 110;
    const synthesisP50Ms = Number.isFinite(options.synthesisP50Ms)
        ? options.synthesisP50Ms : Math.max(firstAudioP50Ms + 40, 160);
    const report = {
        success: true,
        browser: options.browser || 'unknown',
        serverCardTested: true,
        playableMp3Returned: true,
        decodeableMp3: options.decodeableMp3 !== false,
        mp3FixtureBytes: MINIMAL_MP3_BYTES.length,
        audioDataUrlPrefix: 'data:audio',
        streamingTtfaMeasured: options.streamingTtfaMeasured !== false,
        firstAudioP50Ms,
        synthesisP50Ms,
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
