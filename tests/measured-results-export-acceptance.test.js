/** @jest-environment node */
/**
 * Contract for dual-scope measured local English export (#61 / KE-30).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'measured-results-export-acceptance.mjs')).href;
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const modelManager = path.join(root, 'model-manager-page.js');
const benchmarkHtml = path.join(root, 'benchmark.html');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as exp from ${JSON.stringify(helperUrl)};
const payload = {
    kind: exp.MEASURED_EXPORT_KIND,
    localOnly: true,
    telemetry: false,
    noRanking: true,
    measurementKind: 'warm-full-clip-synthesis',
    firstAudioMeasured: false,
    sampleText: 'Hello world.',
    measurements: [
        { key: 'onnx-q8', label: 'ONNX', synthesisP50Ms: 12,
            synthesisP95Ms: 15, realTimeFactorP50: 0.2 },
        { key: 'mediapipe-cpu', label: 'MediaPipe', synthesisP50Ms: 18,
            synthesisP95Ms: 22, realTimeFactorP50: 0.3 },
    ],
};
exp.assertMeasuredResultsExportPayload(payload, {
    keys: ['onnx-q8', 'mediapipe-cpu'],
    sampleText: 'Hello world.',
});
const report = exp.buildMeasuredResultsExportReport({
    browser: 'chromium',
    keys: ['onnx-q8', 'mediapipe-cpu'],
    sampleText: 'Hello world.',
    fileContentsVerified: true,
});
exp.assertMeasuredResultsExportReport(report);
const fail = (() => {
    try {
        exp.assertMeasuredResultsExportReport({ success: false });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const badPayload = (() => {
    try {
        exp.assertMeasuredResultsExportPayload({
            ...payload, telemetry: true,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    kind: exp.MEASURED_EXPORT_KIND,
    filename: exp.MEASURED_EXPORT_FILENAME,
    buttonId: exp.MEASURED_EXPORT_BUTTON_ID,
    statusNeedle: exp.MEASURED_EXPORT_STATUS_NEEDLE,
    report, fail, badPayload,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('Measured results export acceptance', () => {
    test('shared helper builds report and rejects bad shapes', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.kind).toBe('kokoro-measured-local-english');
        expect(snap.filename).toBe('kokoro-measured-local-english.json');
        expect(snap.buttonId).toBe('exportMeasuredResults');
        expect(snap.statusNeedle).toMatch(/Nothing was uploaded/i);
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            localOnly: true,
            telemetry: false,
            noRanking: true,
            downloadTriggered: true,
            statusConfirmed: true,
            fileContentsVerified: true,
        }));
        expect(snap.fail.ok).toBe(false);
        expect(snap.fail.message).toMatch(/not successful/i);
        expect(snap.badPayload.ok).toBe(false);
        expect(snap.badPayload.message).toMatch(/local-only|telemetry/i);
    });

    test('product page exposes local-only measured export control', () => {
        const html = fs.readFileSync(benchmarkHtml, 'utf8');
        const source = fs.readFileSync(modelManager, 'utf8');
        expect(html).toContain('id="exportMeasuredResults"');
        expect(html).toContain('id="measuredExportStatus"');
        expect(source).toContain('buildMeasuredEnglishExport');
        expect(source).toContain('exportMeasuredEnglishResults');
        expect(source).toContain('downloadPinnedMeasuredExport');
        expect(source).toContain('downloads.onChanged');
        expect(source).toContain('Measured export download interrupted');
        expect(source).toContain('return await done');
        expect(source).toContain('__kokoroLastMeasuredExport');
        expect(source).toContain('__kokoroLastMeasuredExportDownloadId');
        expect(source).toContain('kokoro-measured-local-english');
        expect(source).toContain('telemetry: false');
        expect(source).toContain('noRanking: true');
        expect(source).toContain('Nothing was uploaded');
        expect(source).not.toContain('navigator.sendBeacon');
        expect(source).not.toMatch(
            /exportMeasuredEnglishResults[\s\S]*?fetch\(/);
        expect(source).not.toMatch(/setTimeout\(\s*\(\)\s*=>\s*\{[^}]*revokeObjectURL/);
    });

    test('Chromium dual path exports before sample-edit clear', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toContain('measured-results-export-acceptance.mjs');
        expect(source).toContain('async function acceptMeasuredResultsExport');
        expect(source).toContain('measuredResultsExport');
        expect(source).toContain('__kokoroLastMeasuredExport');
        expect(source).toContain('MEASURED_EXPORT_BUTTON_ID');
        expect(source).toContain('fileContentsVerified: true');
        expect(source).toContain('readFile(savedPath');
        const exportIdx = source.indexOf(
            'await acceptMeasuredResultsExport(page');
        const editIdx = source.indexOf(
            "await page.locator('#benchmarkText').fill(" +
            "'Another shared English sample.')");
        expect(exportIdx).toBeGreaterThan(0);
        expect(editIdx).toBeGreaterThan(exportIdx);
    });

    test('Firefox dual path exports before sample-edit clear', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toContain('firefox_measured_results_export_acceptance');
        expect(source).toContain('def accept_measured_results_export');
        expect(source).toContain('measuredResultsExport');
        expect(source).toContain('__kokoroLastMeasuredExport');
        expect(source).toContain('fileContentsVerified=True');
        expect(source).toContain('browser.downloads.search');
        expect(source).toContain("__kokoroLastMeasuredExportDownloadId");
        expect(source).toContain('search({ id: downloadId })');
        expect(source).toContain('from_file = json.loads');
        const bridge = fs.readFileSync(path.join(
            root, 'scripts', 'firefox_measured_results_export_acceptance.py'), 'utf8');
        const nodeBridge = fs.readFileSync(path.join(
            root, 'scripts', 'measured-results-export-node-bridge.mjs'), 'utf8');
        expect(bridge).toContain('measured-results-export-node-bridge.mjs');
        expect(bridge).toContain('["node", str(_BRIDGE), "constants"]');
        expect(bridge).toContain('["node", str(_BRIDGE), "assert-payload"]');
        expect(bridge).toContain('input=json.dumps');
        expect(bridge).toContain('def build_measured_results_export_report');
        expect(bridge).not.toContain('node", "--input-type=module", "-e"');
        expect(bridge).not.toMatch(
            /assertMeasuredResultsExportPayload\(\s*\+\s*json\.dumps/);
        expect(nodeBridge).toContain('assert-payload');
        expect(nodeBridge).toContain('readFileSync(0');
        expect(nodeBridge).toContain('assertMeasuredResultsExportPayload');
        expect(nodeBridge).not.toContain('process.argv[3]');
        expect(nodeBridge).not.toContain('buildMeasuredResultsExportReport');
        const exportIdx = source.indexOf(
            'measured_results_export = accept_measured_results_export(');
        const editIdx = source.indexOf(
            "text.value='Another shared English sample.'");
        expect(exportIdx).toBeGreaterThan(0);
        expect(editIdx).toBeGreaterThan(exportIdx);
    });
});
