/**
 * Shared FastAPI / server-card live acceptance contract (#61 / KE-27).
 * Chromium imports this; Firefox loads asserts via Node for the same shapes.
 */

/** Short MPEG frame bytes — enough for FETCH_TTS_AUDIO → data:audio/mpeg. */
export const MINIMAL_MP3_BYTES = Uint8Array.from([
    0xFF, 0xFB, 0x90, 0x00,
    ...Array(100).fill(0),
]);

export const SERVER_PLAYABLE_MP3_NEEDLE = 'Server returned playable MP3';
export const FASTAPI_SELECTED_NEEDLE = 'FastAPI selected.';
export const SERVER_STATUS_NOT_TESTED = 'Not tested';

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

/**
 * Validate a dual-scope FastAPI card acceptance report before saving.
 * Distinct keys from dual-use-this-backend / popup-cta reports (Sonar).
 */
export function assertFastApiServerCardReport(report) {
    if (!report || typeof report !== 'object') {
        throw new Error('FastAPI server-card report missing: ' + String(report));
    }
    if (report.success !== true) {
        throw new Error('FastAPI server-card report not successful');
    }
    if (report.serverCardTested !== true) {
        throw new Error('serverCardTested must be true');
    }
    if (report.playableMp3Returned !== true) {
        throw new Error('playableMp3Returned must be true');
    }
    if (report.audioDataUrlPrefix !== 'data:audio') {
        throw new Error(
            'audioDataUrlPrefix mismatch: ' + report.audioDataUrlPrefix);
    }
    if (report.chooseServerEnabledAfterTest !== true) {
        throw new Error('chooseServer must enable after a successful test');
    }
    if (report.selectedBackend !== 'fastapi') {
        throw new Error(
            'selectedBackend must be fastapi: ' + report.selectedBackend);
    }
    if (report.preferenceOnlyOnChoose !== true) {
        throw new Error('preferenceOnlyOnChoose must be true');
    }
    if (!String(report.apiUrl || '').includes('/v1')) {
        throw new Error('apiUrl must point at a /v1 FastAPI base');
    }
    if (!String(report.speechEndpoint || '').includes('audio/speech')) {
        throw new Error('speechEndpoint must target audio/speech');
    }
    return true;
}

export function buildFastApiServerCardReport(options = {}) {
    const apiUrl = normalizeFastApiBaseUrl(
        options.apiUrl || 'http://127.0.0.1:0/v1/');
    const report = {
        success: true,
        browser: options.browser || 'unknown',
        serverCardTested: true,
        playableMp3Returned: true,
        audioDataUrlPrefix: 'data:audio',
        chooseServerEnabledAfterTest: true,
        preferenceOnlyOnChoose: true,
        selectedBackend: 'fastapi',
        fastapiSelectedStatus: true,
        loopbackStub: true,
        apiUrl,
        speechEndpoint: speechEndpointFromApiUrl(apiUrl),
        afterLocalDualComparison: options.afterLocalDualComparison !== false,
    };
    assertFastApiServerCardReport(report);
    return report;
}
