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
    coldPrepMeasured: true,
    firstAudioMeasured: false,
    storageFootprintMeasured: false,
    storageFootprintSource: 'cache-presence-catalog',
    cachePresenceProbed: true,
    englishDictionaryCatalogBytes: 3618488,
    runtimeHeapMeasured: false,
    storeSigning: {
        storePackagesSigned: false,
        storeSigningMeasured: false,
        disclosureNeedle: 'store distribution signing not measured',
    },
    sampleText: 'Hello world.',
    measurements: [
        { key: 'onnx-q8', label: 'ONNX', coldPrepMs: 40, synthesisP50Ms: 12,
            synthesisP95Ms: 15, realTimeFactorP50: 0.2,
            catalogModelAssetBytes: 92885404,
            requiredDictionaryCatalogBytes: 3618488,
            catalogEnglishPathBytes: 92885404 + 3618488,
            cachedCatalogAssetBytes: 92885404,
            cachedCatalogDictionaryBytes: 3618488,
            cachedCatalogEnglishPathBytes: 92885404 + 3618488 },
        { key: 'mediapipe-cpu', label: 'MediaPipe', coldPrepMs: 55,
            synthesisP50Ms: 18, synthesisP95Ms: 22, realTimeFactorP50: 0.3,
            catalogModelAssetBytes: 294783298,
            cachedCatalogAssetBytes: 294783298 },
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
const badHeap = (() => {
    try {
        exp.assertMeasuredResultsExportPayload({
            ...payload, runtimeHeapMeasured: true,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const badFootprint = (() => {
    try {
        const rows = payload.measurements.map((row, i) =>
            i === 0 ? { ...row, cachedCatalogAssetBytes: 0 } : row);
        exp.assertMeasuredResultsExportPayload({
            ...payload, measurements: rows,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const badMeasuredClaim = (() => {
    try {
        exp.assertMeasuredResultsExportPayload({
            ...payload,
            storageFootprintMeasured: true,
            storageFootprintSource: 'cache-storage',
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const badOnnxDict = (() => {
    try {
        const rows = payload.measurements.map((row, i) =>
            i === 0 ? { ...row, requiredDictionaryCatalogBytes: 1 } : row);
        exp.assertMeasuredResultsExportPayload({
            ...payload, measurements: rows,
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
    acceptCanonical: exp.isAcceptableMeasuredExportFilename(
        exp.MEASURED_EXPORT_FILENAME),
    acceptGuid: exp.isAcceptableMeasuredExportFilename(
        '49fc190f-3ab7-44d9-ae35-c20f953bf83d.json'),
    acceptRename: exp.isAcceptableMeasuredExportFilename(
        'kokoro-measured-local-english (1).json'),
    rejectOther: exp.isAcceptableMeasuredExportFilename('notes.txt'),
    report, fail, badPayload, badHeap, badFootprint,
    badMeasuredClaim, badOnnxDict,
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
        expect(snap.acceptCanonical).toBe(true);
        expect(snap.acceptGuid).toBe(true);
        expect(snap.acceptRename).toBe(true);
        expect(snap.rejectOther).toBe(false);
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
        expect(snap.badHeap.ok).toBe(false);
        expect(snap.badHeap.message).toMatch(/runtime heap/i);
        expect(snap.badFootprint.ok).toBe(false);
        expect(snap.badFootprint.message).toMatch(/Invalid measured export metric/i);
        expect(snap.badMeasuredClaim.ok).toBe(false);
        expect(snap.badMeasuredClaim.message).toMatch(
            /catalog presence as measured storage/i);
        expect(snap.badOnnxDict.ok).toBe(false);
        expect(snap.badOnnxDict.message).toMatch(/CMUdict catalog/i);
    });

    test('product page exposes local-only measured export control', () => {
        const html = fs.readFileSync(benchmarkHtml, 'utf8');
        const source = fs.readFileSync(modelManager, 'utf8');
        expect(html).toContain('id="exportMeasuredResults"');
        expect(html).toContain('id="measuredExportStatus"');
        expect(html).toContain('pinned catalog model asset bytes');
        expect(html).toContain('Cache Storage presence estimate');
        expect(html).toContain('not measured body/disk usage');
        expect(html).toContain('runtime WASM/WebGPU heap is not measured');
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
        expect(source).toContain('coldPrepMeasured: true');
        expect(source).toContain('coldPrepMs');
        expect(source).toContain('catalogModelAssetBytes');
        expect(source).toContain('cachedCatalogAssetBytes');
        expect(source).toContain('cachedCatalogDictionaryBytes');
        expect(source).toContain('cachedCatalogEnglishPathBytes');
        expect(source).toContain('snapshotMeasuredEnglishRows');
        expect(source).toContain('probeCachedCatalogPresence');
        expect(source).toContain('attachCachedCatalogPresenceFields');
        expect(source).toContain('storageFootprintMeasured: false');
        expect(source).toContain("? 'cache-presence-catalog' : 'catalog'");
        expect(source).toContain('cachePresenceProbed');
        expect(source).toContain('englishDictionaryCatalogBytes');
        expect(source).toContain('requiredDictionaryCatalogBytes');
        expect(source).toContain('catalogEnglishPathBytes');
        expect(source).toContain('runtimeHeapMeasured: false');
        expect(source).toContain('storeSigning: discloseStoreSigning()');
        expect(source).toContain('await buildMeasuredEnglishExport()');
        expect(source).not.toContain('storageFootprintBytes');
        expect(source).not.toContain('cacheStorageStoredBytes');
        expect(source).not.toContain("storageFootprintSource: 'cache-storage'");
        const helper = fs.readFileSync(path.join(
            root, 'scripts', 'measured-results-export-acceptance.mjs'), 'utf8');
        expect(helper).toContain('requirePositiveMetricFields');
        expect(helper).toContain('assertOnnxStorageDisclosure');
        expect(helper).toContain('storageFootprintMeasured\', false');
        expect(helper).toContain('cache-presence-catalog');
        expect(html).toContain('Cold prep');
        expect(source).toContain('Nothing was uploaded');
        expect(source).not.toContain('navigator.sendBeacon');
        // Export helper itself must stay local-download-only (FastAPI MSE
        // measurement uses fetch later in the file — do not scan past the
        // export function body).
        const exportStart = source.indexOf(
            'async function exportMeasuredEnglishResults()');
        expect(exportStart).toBeGreaterThan(0);
        const exportBody = source.slice(
            exportStart, source.indexOf('\nfunction forgetSharedEnglishResult'));
        expect(exportBody).toContain('downloadPinnedMeasuredExport');
        expect(exportBody).not.toContain('fetch(');
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
        expect(source).toContain('isAcceptableMeasuredExportFilename');
        expect(source).not.toContain(
            "if (suggested !== MEASURED_EXPORT_FILENAME)");
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
