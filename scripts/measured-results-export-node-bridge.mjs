/**
 * CLI bridge for Firefox Python harness.
 * Action in argv[2]; JSON payload on stdin (no filesystem path argv).
 */
import { readFileSync } from 'node:fs';
import {
    MEASURED_EXPORT_BUTTON_ID,
    MEASURED_EXPORT_FILENAME,
    MEASURED_EXPORT_KIND,
    MEASURED_EXPORT_STATUS_NEEDLE,
    assertMeasuredResultsExportPayload,
    assertMeasuredResultsExportReport,
} from './measured-results-export-acceptance.mjs';

function readStdinJson() {
    const raw = readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : null;
}

function writeJson(value) {
    process.stdout.write(JSON.stringify(value) + '\n');
}

const action = process.argv[2];

if (action === 'constants') {
    writeJson({
        kind: MEASURED_EXPORT_KIND,
        filename: MEASURED_EXPORT_FILENAME,
        buttonId: MEASURED_EXPORT_BUTTON_ID,
        statusNeedle: MEASURED_EXPORT_STATUS_NEEDLE,
    });
} else if (action === 'assert-payload') {
    const data = readStdinJson();
    assertMeasuredResultsExportPayload(data.payload, data.expected);
    writeJson({ ok: true });
} else if (action === 'assert-report') {
    const report = readStdinJson();
    assertMeasuredResultsExportReport(report);
    writeJson({ ok: true });
} else {
    throw new Error('Unknown measured-export bridge action: ' + action);
}
