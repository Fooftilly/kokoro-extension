/**
 * #61 / KE-30 — local-only export of measured English comparison rows.
 * Shared by Chromium dual live harness + Jest contracts.
 */

export const MEASURED_EXPORT_KIND = 'kokoro-measured-local-english';
export const MEASURED_EXPORT_FILENAME = 'kokoro-measured-local-english.json';
export const MEASURED_EXPORT_BUTTON_ID = 'exportMeasuredResults';
export const MEASURED_EXPORT_STATUS_NEEDLE =
    'Measured results exported locally. Nothing was uploaded.';

export function assertMeasuredResultsExportPayload(payload, expected = {}) {
    if (!payload || typeof payload !== 'object') {
        throw Error('Measured export payload missing');
    }
    if (payload.kind !== MEASURED_EXPORT_KIND) {
        throw Error('Unexpected measured export kind: ' + payload.kind);
    }
    if (payload.localOnly !== true || payload.telemetry !== false ||
        payload.noRanking !== true) {
        throw Error('Measured export must stay local-only with no ranking/telemetry');
    }
    if (payload.measurementKind !== 'warm-full-clip-synthesis' ||
        payload.firstAudioMeasured !== false) {
        throw Error('Measured export must disclose warm full-clip (not first-audio)');
    }
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
    for (const row of payload.measurements) {
        for (const field of [
            'synthesisP50Ms', 'synthesisP95Ms', 'realTimeFactorP50',
        ]) {
            if (!Number.isFinite(row[field]) || row[field] <= 0) {
                throw Error('Invalid measured export metric: ' +
                    JSON.stringify(row));
            }
        }
    }
    if (expected.sampleText != null &&
        payload.sampleText !== expected.sampleText) {
        throw Error('Measured export sample mismatch: ' + payload.sampleText);
    }
    return true;
}

export function buildMeasuredResultsExportReport(options = {}) {
    return {
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
    };
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
    return true;
}
