/**
 * CLI bridge for Firefox Python harness — actions + optional JSON argv file.
 * Keeps subprocess.run list literals static (Sourcery/Sonar).
 */
import { readFileSync } from 'node:fs';
import {
    MEASURED_EXPORT_BUTTON_ID,
    MEASURED_EXPORT_FILENAME,
    MEASURED_EXPORT_KIND,
    MEASURED_EXPORT_STATUS_NEEDLE,
    assertMeasuredResultsExportPayload,
    assertMeasuredResultsExportReport,
    buildMeasuredResultsExportReport,
} from './measured-results-export-acceptance.mjs';

const action = process.argv[2];
const dataPath = process.argv[3];
const data = dataPath
    ? JSON.parse(readFileSync(dataPath, 'utf8'))
    : null;

if (action === 'constants') {
    console.log(JSON.stringify({
        kind: MEASURED_EXPORT_KIND,
        filename: MEASURED_EXPORT_FILENAME,
        buttonId: MEASURED_EXPORT_BUTTON_ID,
        statusNeedle: MEASURED_EXPORT_STATUS_NEEDLE,
    }));
} else if (action === 'assert-payload') {
    assertMeasuredResultsExportPayload(data.payload, data.expected);
    console.log(JSON.stringify({ ok: true }));
} else if (action === 'build-report') {
    console.log(JSON.stringify(buildMeasuredResultsExportReport(data)));
} else if (action === 'assert-report') {
    assertMeasuredResultsExportReport(data);
    console.log(JSON.stringify({ ok: true }));
} else {
    throw new Error('Unknown measured-export bridge action: ' + action);
}
