/** @jest-environment node */
/**
 * Contract for store / distribution signing not-measured disclosure (#61 / KE-46).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'store-signing-disclosure-acceptance.mjs')).href;
const measuredHelperUrl = pathToFileURL(
    path.join(root, 'scripts', 'measured-results-export-acceptance.mjs')).href;
const disclosureModule = require('../store-signing-disclosure.js');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const modelManager = path.join(root, 'model-manager-page.js');
const disclosureSource = path.join(root, 'store-signing-disclosure.js');
const buildSource = path.join(root, 'build.js');
const eslintSource = path.join(root, 'eslint.config.mjs');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as store from ${JSON.stringify(helperUrl)};
const ok = store.assertStoreSigningDisclosure({
    storeSigning: {
        storePackagesSigned: false,
        storeSigningMeasured: false,
        disclosureNeedle: store.STORE_SIGNING_NOT_MEASURED_NEEDLE,
    },
});
const report = store.buildStoreSigningDisclosureReport({
    browser: 'Firefox',
});
const failSigned = (() => {
    try {
        store.assertStoreSigningDisclosure({
            storeSigning: {
                storePackagesSigned: true,
                storeSigningMeasured: false,
                disclosureNeedle: store.STORE_SIGNING_NOT_MEASURED_NEEDLE,
            },
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failMeasured = (() => {
    try {
        store.assertStoreSigningDisclosure({
            storeSigning: {
                storePackagesSigned: false,
                storeSigningMeasured: true,
                disclosureNeedle: store.STORE_SIGNING_NOT_MEASURED_NEEDLE,
            },
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failFlatFallback = (() => {
    try {
        store.assertStoreSigningDisclosure({
            storePackagesSigned: false,
            storeSigningMeasured: false,
            disclosureNeedle: store.STORE_SIGNING_NOT_MEASURED_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    needle: store.STORE_SIGNING_NOT_MEASURED_NEEDLE,
    ok, report, failSigned, failMeasured, failFlatFallback,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('Store signing disclosure acceptance (KE-46)', () => {
    test('discloseStoreSigning never claims packages signed or measured', () => {
        const disclosure = disclosureModule.discloseStoreSigning();
        expect(disclosure).toEqual({
            storePackagesSigned: false,
            storeSigningMeasured: false,
            disclosureNeedle: disclosureModule.STORE_SIGNING_NOT_MEASURED_NEEDLE,
        });
        expect(disclosure.disclosureNeedle).toContain(
            'store distribution signing not measured');
    });

    test('shared acceptance helper asserts and builds dual report', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.needle).toBe('store distribution signing not measured');
        expect(snap.ok).toEqual(expect.objectContaining({
            success: true,
            storePackagesSigned: false,
            storeSigningMeasured: false,
        }));
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            storePackagesSigned: false,
            storeSigningMeasured: false,
            assertedFromExport: true,
        }));
        expect(snap.failSigned.ok).toBe(false);
        expect(snap.failSigned.message).toMatch(/must not be claimed signed/i);
        expect(snap.failMeasured.ok).toBe(false);
        expect(snap.failMeasured.message).toMatch(
            /must not be reported as measured/i);
        expect(snap.failFlatFallback.ok).toBe(false);
        expect(snap.failFlatFallback.message).toMatch(
            /must nest storeSigning/i);
    });

    test('source wiring: model-manager + measured export + dual live asserts', () => {
        const disclosure = fs.readFileSync(disclosureSource, 'utf8');
        const manager = fs.readFileSync(modelManager, 'utf8');
        const measured = fs.readFileSync(path.join(
            root, 'scripts', 'measured-results-export-acceptance.mjs'), 'utf8');
        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        const chromium = fs.readFileSync(chromiumLive, 'utf8');
        const build = fs.readFileSync(buildSource, 'utf8');
        const eslint = fs.readFileSync(eslintSource, 'utf8');

        expect(disclosure).toContain('discloseStoreSigning');
        expect(disclosure).toContain('storePackagesSigned: false');
        expect(disclosure).toContain('storeSigningMeasured: false');
        expect(manager).toContain(
            "import { discloseStoreSigning } from './store-signing-disclosure.js'");
        expect(manager).toContain('storeSigning: discloseStoreSigning()');
        expect(measured).toContain('assertStoreSigningDisclosure');
        expect(measured).toContain('store-signing-disclosure-acceptance.mjs');
        expect(build).toContain("'store-signing-disclosure.js'");
        expect(eslint).toContain("'store-signing-disclosure.js'");

        expect(firefox).toContain('store-signing-disclosure-acceptance.mjs');
        expect(firefox).toContain('assert_store_signing_disclosure_from_payload');
        expect(firefox).toContain('storeSigningDisclosureAcceptance');
        const dualGate = firefox.indexOf('if dual_comparison:');
        const dualCompare = firefox.indexOf(
            'accept_two_backend_comparison(driver, state["origin"])');
        const storeFromExport = firefox.indexOf(
            'Store signing disclosure missing verified export evidence');
        // Dual must lift storeSigning from verified measured export evidence.
        expect(dualGate).toBeGreaterThan(0);
        expect(dualCompare).toBeGreaterThan(dualGate);
        expect(storeFromExport).toBeGreaterThan(dualCompare);
        expect(firefox).toContain('assertedFromExport');
        expect(firefox).toContain(
            'assert_store_signing_disclosure_from_payload');

        expect(chromium).toContain('store-signing-disclosure-acceptance.mjs');
        expect(chromium).toContain('assertStoreSigningDisclosure');
        expect(chromium).toContain('storeSigningDisclosureAcceptance');
        expect(chromium).toContain('buildStoreSigningDisclosureReport');
        const chromiumDualGate = chromium.indexOf(
            "providerFilter === 'both' && !originDownload");
        const chromiumExportAssert = chromium.indexOf(
            'assertStoreSigningDisclosure(fromFile)');
        const chromiumLift = chromium.indexOf(
            'measuredResultsExport\n                    ?.storeSigningDisclosureAcceptance');
        const chromiumPopup = chromium.indexOf(
            'liveHeartbeat(\'popup-test-tts-cta-start\')');
        expect(chromiumDualGate).toBeGreaterThan(0);
        expect(chromiumExportAssert).toBeGreaterThan(0);
        expect(chromiumPopup).toBeGreaterThan(chromiumDualGate);
        expect(chromiumLift).toBeGreaterThan(chromiumPopup);
        expect(chromium).toContain('missing verified export evidence');
        expect(chromium).not.toContain(
            'assertStoreSigningDisclosure({\n            storeSigning: {');
    });

    test('assert fails closed when export omits storeSigning or claims signed', () => {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as store from ${JSON.stringify(helperUrl)};
import * as exp from ${JSON.stringify(measuredHelperUrl)};
const omit = (() => {
    try {
        store.assertStoreSigningDisclosure({
            kind: 'kokoro-measured-local-english',
            runtimeHeapMeasured: false,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const falseSigned = (() => {
    try {
        store.assertStoreSigningDisclosure({
            storeSigning: {
                storePackagesSigned: true,
                storeSigningMeasured: false,
                disclosureNeedle: store.STORE_SIGNING_NOT_MEASURED_NEEDLE,
            },
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const exportOmit = (() => {
    try {
        exp.assertMeasuredResultsExportPayload({
            kind: exp.MEASURED_EXPORT_KIND,
            localOnly: true,
            telemetry: false,
            noRanking: true,
            measurementKind: 'warm-full-clip-synthesis',
            coldPrepMeasured: true,
            firstAudioMeasured: false,
            localPlaybackStartMeasured: true,
            localCancelMeasured: true,
            nativeForceInterruptSupported: false,
            cancelJoinProbeText: 'Cancel join probe.',
            storageFootprintMeasured: true,
            storageFootprintSource: 'cache-body-bytes',
            cachePresenceProbed: true,
            englishDictionaryCatalogBytes: 3618488,
            runtimeHeapMeasured: false,
            sampleText: 'Hello world.',
            measurements: [
                { key: 'onnx-q8', label: 'ONNX', coldPrepMs: 40,
                    synthesisP50Ms: 12, synthesisP95Ms: 15,
                    realTimeFactorP50: 0.2, playbackStartP50Ms: 14,
                    cancelJoinP50Ms: 8,
                    catalogModelAssetBytes: 92885404,
                    requiredDictionaryCatalogBytes: 3618488,
                    catalogEnglishPathBytes: 92885404 + 3618488,
                    cachedCatalogAssetBytes: 92885404,
                    measuredCacheBodyBytes: 92885404,
                    cachedCatalogDictionaryBytes: 3618488,
                    measuredCacheDictionaryBytes: 3618488,
                    cachedCatalogEnglishPathBytes: 92885404 + 3618488 },
                { key: 'mediapipe-cpu', label: 'MediaPipe', coldPrepMs: 55,
                    synthesisP50Ms: 18, synthesisP95Ms: 22,
                    realTimeFactorP50: 0.3, playbackStartP50Ms: 20,
                    cancelJoinP50Ms: 9,
                    catalogModelAssetBytes: 294783298,
                    cachedCatalogAssetBytes: 294783298,
                    measuredCacheBodyBytes: 294783298 },
            ],
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({ omit, falseSigned, exportOmit }));
`], { encoding: 'utf8', cwd: root });
        expect(child.status).toBe(0);
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.omit.ok).toBe(false);
        expect(snap.omit.message).toMatch(/must nest storeSigning/i);
        expect(snap.falseSigned.ok).toBe(false);
        expect(snap.falseSigned.message).toMatch(/must not be claimed signed/i);
        expect(snap.exportOmit.ok).toBe(false);
        expect(snap.exportOmit.message).toMatch(/must nest storeSigning/i);
    });
});
