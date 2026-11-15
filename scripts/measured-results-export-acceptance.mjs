/**
 * #61 / KE-30 — local-only export of measured English comparison rows.
 * Shared by Chromium dual live harness + Jest contracts.
 */

export const MEASURED_EXPORT_KIND = 'kokoro-measured-local-english';
export const MEASURED_EXPORT_FILENAME = 'kokoro-measured-local-english.json';
export const MEASURED_EXPORT_BUTTON_ID = 'exportMeasuredResults';
export const MEASURED_EXPORT_STATUS_NEEDLE =
    'Measured results exported locally. Nothing was uploaded.';

/**
 * Playwright's download.suggestedFilename() for chrome.downloads.download
 * often returns a UUID.json GUID even when the extension requested
 * MEASURED_EXPORT_FILENAME. Accept the canonical name, auto-renames, or a
 * GUID.json — file contents are asserted separately.
 */
export function isAcceptableMeasuredExportFilename(name) {
    const base = String(name || '').split(/[/\\]/).pop() || '';
    if (base === MEASURED_EXPORT_FILENAME) return true;
    const stem = MEASURED_EXPORT_FILENAME.replace(/\.json$/i, '');
    const renamed = new RegExp(
        '^' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '(?:\\s*\\(\\d+\\)|-\\d+)?\\.json$', 'i');
    if (renamed.test(base)) return true;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
        .test(base);
}

function requireMeasuredFlag(payload, key, expected, message) {
    if (payload[key] !== expected) throw Error(message);
}

function assertMeasuredExportPrivacy(payload) {
    requireMeasuredFlag(payload, 'localOnly', true,
        'Measured export must stay local-only with no ranking/telemetry');
    requireMeasuredFlag(payload, 'telemetry', false,
        'Measured export must stay local-only with no ranking/telemetry');
    requireMeasuredFlag(payload, 'noRanking', true,
        'Measured export must stay local-only with no ranking/telemetry');
}

function assertMeasuredExportDisclosure(payload) {
    requireMeasuredFlag(payload, 'measurementKind', 'warm-full-clip-synthesis',
        'Measured export must disclose warm full-clip (not first-audio)');
    requireMeasuredFlag(payload, 'coldPrepMeasured', true,
        'Measured export must disclose cold prep separately from warm runs');
    requireMeasuredFlag(payload, 'firstAudioMeasured', false,
        'Measured export must disclose warm full-clip (not first-audio)');
    requireMeasuredFlag(payload, 'storageFootprintMeasured', false,
        'Measured export must not claim catalog sizes as measured storage');
    requireMeasuredFlag(payload, 'storageFootprintSource', 'catalog',
        'Measured export must disclose catalog as the storage footprint source');
    requireMeasuredFlag(payload, 'runtimeHeapMeasured', false,
        'Measured export must not invent runtime heap (WASM/WebGPU)');
    if (!Number.isFinite(payload.englishDictionaryCatalogBytes) ||
        payload.englishDictionaryCatalogBytes <= 0) {
        throw Error('Measured export must disclose pinned CMUdict catalog bytes');
    }
}

function assertMeasuredExportRows(payload, expected = {}) {
    if (!Array.isArray(payload.measurements) || !payload.measurements.length) {
        throw Error('Measured export has no measurements');
    }
    const requiredKeys = expected.keys || ['onnx-q8', 'mediapipe-cpu'];
    const keys = payload.measurements.map(row => row.key);
    for (const key of requiredKeys) {
        if (!keys.includes(key)) {
            throw Error('Measured export missing backend ' + key + ': ' +
                JSON.stringify(keys));
        }
    }
    const dictionaryBytes = payload.englishDictionaryCatalogBytes;
    for (const row of payload.measurements) {
        for (const field of [
            'coldPrepMs', 'synthesisP50Ms', 'synthesisP95Ms', 'realTimeFactorP50',
            'catalogModelAssetBytes',
        ]) {
            if (!Number.isFinite(row[field]) || row[field] <= 0) {
                throw Error('Invalid measured export metric: ' +
                    JSON.stringify(row));
            }
        }
        if (String(row.key || '').startsWith('onnx-')) {
            if (row.requiredDictionaryCatalogBytes !== dictionaryBytes) {
                throw Error('ONNX row must disclose required CMUdict catalog bytes: ' +
                    JSON.stringify(row));
            }
            if (row.catalogEnglishPathBytes !==
                row.catalogModelAssetBytes + dictionaryBytes) {
                throw Error('ONNX catalogEnglishPathBytes must equal model + CMUdict: ' +
                    JSON.stringify(row));
            }
        }
    }
    if (expected.sampleText != null &&
        payload.sampleText !== expected.sampleText) {
        throw Error('Measured export sample mismatch: ' + payload.sampleText);
    }
}

/** Nested helpers keep CodeFactor method complexity under the gate. */
export function assertMeasuredResultsExportPayload(payload, expected = {}) {
    if (!payload || typeof payload !== 'object') {
        throw Error('Measured export payload missing');
    }
    if (payload.kind !== MEASURED_EXPORT_KIND) {
        throw Error('Unexpected measured export kind: ' + payload.kind);
    }
    assertMeasuredExportPrivacy(payload);
    assertMeasuredExportDisclosure(payload);
    assertMeasuredExportRows(payload, expected);
    return true;
}

export function buildMeasuredResultsExportReport(options = {}) {
    const report = {
        success: options.success !== false,
        browser: options.browser || 'chromium',
        localOnly: true,
        telemetry: false,
        noRanking: true,
        filename: MEASURED_EXPORT_FILENAME,
        keys: options.keys || ['onnx-q8', 'mediapipe-cpu'],
        sampleText: options.sampleText || 'Hello world.',
        statusConfirmed: options.statusConfirmed !== false,
        downloadTriggered: options.downloadTriggered !== false,
        fileContentsVerified: options.fileContentsVerified === true,
    };
    if (options.playwrightSuggestedFilename != null) {
        report.playwrightSuggestedFilename = options.playwrightSuggestedFilename;
    }
    return report;
}

export function assertMeasuredResultsExportReport(report) {
    if (!report?.success) {
        throw Error('Measured results export acceptance not successful');
    }
    if (report.localOnly !== true || report.telemetry !== false ||
        report.noRanking !== true) {
        throw Error('Measured export report privacy flags incorrect');
    }
    if (!report.downloadTriggered || !report.statusConfirmed) {
        throw Error('Measured export UI signals incomplete');
    }
    if (report.fileContentsVerified !== true) {
        throw Error('Measured export file contents were not verified');
    }
    return true;
}
