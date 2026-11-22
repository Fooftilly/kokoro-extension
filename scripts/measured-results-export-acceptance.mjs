/**
 * #61 / KE-30 — local-only export of measured English comparison rows.
 * Shared by Chromium dual live harness + Jest contracts.
 */

import { assertStoreSigningDisclosure } from
    './store-signing-disclosure-acceptance.mjs';

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
    // Dual-comparison live requires muted full-clip playback start measured.
    // Synthesis-only honesty exports may set localPlaybackStartMeasured:false
    // (audio-element quirks); those must not pass this dual gate.
    requireMeasuredFlag(payload, 'localPlaybackStartMeasured', true,
        'Measured export must report muted full-clip playback start');
    requireMeasuredFlag(payload, 'storageFootprintMeasured', true,
        'Measured export must report measured cache-body storage footprint');
    requireMeasuredFlag(payload, 'storageFootprintSource', 'cache-body-bytes',
        'Measured export must disclose cache-body-bytes footprint source');
    requireMeasuredFlag(payload, 'cachePresenceProbed', true,
        'Measured export must disclose that cache bodies were probed');
    requireMeasuredFlag(payload, 'runtimeHeapMeasured', false,
        'Measured export must not invent runtime heap (WASM/WebGPU)');
    // #61 / KE-46: store / distribution signing honesty (nested block).
    assertStoreSigningDisclosure(payload);
    if (!Number.isFinite(payload.englishDictionaryCatalogBytes) ||
        payload.englishDictionaryCatalogBytes <= 0) {
        throw Error('Measured export must disclose pinned CMUdict catalog bytes');
    }
}

function requirePositiveMetricFields(row, fields) {
    for (const field of fields) {
        if (!Number.isFinite(row[field]) || row[field] <= 0) {
            throw Error('Invalid measured export metric: ' + JSON.stringify(row));
        }
    }
}

function assertMeasuredBodyBytes(row) {
    if (row.measuredCacheBodyBytes !== row.catalogModelAssetBytes ||
        row.cachedCatalogAssetBytes !== row.catalogModelAssetBytes) {
        throw Error(
            'Measured cache body bytes must match catalog model bytes: ' +
            JSON.stringify(row));
    }
}

function assertOnnxStorageDisclosure(row, dictionaryBytes) {
    if (!String(row.key || '').startsWith('onnx-')) return;
    if (row.requiredDictionaryCatalogBytes !== dictionaryBytes) {
        throw Error('ONNX row must disclose required CMUdict catalog bytes: ' +
            JSON.stringify(row));
    }
    if (row.catalogEnglishPathBytes !==
        row.catalogModelAssetBytes + dictionaryBytes) {
        throw Error('ONNX catalogEnglishPathBytes must equal model + CMUdict: ' +
            JSON.stringify(row));
    }
    if (!Number.isFinite(row.cachedCatalogDictionaryBytes) ||
        row.cachedCatalogDictionaryBytes !== dictionaryBytes ||
        row.measuredCacheDictionaryBytes !== dictionaryBytes) {
        throw Error(
            'ONNX row must disclose measured CMUdict body bytes equal to ' +
            'englishDictionaryCatalogBytes: ' + JSON.stringify(row));
    }
    if (row.cachedCatalogEnglishPathBytes !==
        row.cachedCatalogAssetBytes + row.cachedCatalogDictionaryBytes) {
        throw Error('ONNX cachedCatalogEnglishPathBytes must equal model + CMUdict: ' +
            JSON.stringify(row));
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
        requirePositiveMetricFields(row, [
            'coldPrepMs', 'synthesisP50Ms', 'synthesisP95Ms', 'realTimeFactorP50',
            'playbackStartP50Ms',
            'catalogModelAssetBytes', 'cachedCatalogAssetBytes',
            'measuredCacheBodyBytes',
        ]);
        if (!(row.playbackStartP50Ms >= row.synthesisP50Ms)) {
            throw Error(
                'playbackStartP50Ms must be at/after synthesisP50Ms: ' +
                JSON.stringify(row));
        }
        assertMeasuredBodyBytes(row);
        assertOnnxStorageDisclosure(row, dictionaryBytes);
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
