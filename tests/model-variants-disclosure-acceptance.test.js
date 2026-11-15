/** @jest-environment node */
/**
 * Contract for other model variants / verified-GPU-when-offered disclosure
 * (#57 / #61 / KE-53). Dual scopes accept only onnx-q8 + MediaPipe CPU;
 * catalog evidence (incl. onnx-q8f16) must be observed.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'model-variants-disclosure-acceptance.mjs')).href;
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');

const CATALOG_WITH_Q8F16 = [
    'mediapipe-cpu', 'onnx-fp16', 'onnx-int8', 'onnx-q8', 'onnx-q8f16',
];

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as variants from ${JSON.stringify(helperUrl)};
const observed = ${JSON.stringify(CATALOG_WITH_Q8F16)};
const capture = (fn) => {
    try { return { ok: true, value: fn() }; }
    catch (error) { return { ok: false, message: String(error.message || error) }; }
};
const report = variants.buildModelVariantsDisclosureReport({
    browser: 'Firefox',
    observedCatalogVariantKeys: observed,
});
const ok = variants.assertModelVariantsDisclosure(report);
const nested = variants.assertModelVariantsDisclosure({
    modelVariants: {
        acceptedVariants: ['mediapipe-cpu', 'onnx-q8'],
        observedCatalogVariantKeys: observed,
        otherCatalogVariantsOffered: true,
        otherModelVariantsMeasured: false,
        verifiedGpuWhenOfferedMeasured: false,
        assertedFromCatalog: true,
        disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
    },
});
const failNoQ8f16 = capture(() => variants.assertModelVariantsDisclosure({
    acceptedVariants: ['onnx-q8', 'mediapipe-cpu'],
    observedCatalogVariantKeys: ['mediapipe-cpu', 'onnx-q8'],
    otherCatalogVariantsOffered: true,
    otherModelVariantsMeasured: false,
    verifiedGpuWhenOfferedMeasured: false,
    assertedFromCatalog: true,
    disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
}));
const failHardCodedNoEvidence = capture(() => variants.assertModelVariantsDisclosure({
    acceptedVariants: ['onnx-q8', 'mediapipe-cpu'],
    otherCatalogVariantsOffered: true,
    otherModelVariantsMeasured: false,
    verifiedGpuWhenOfferedMeasured: false,
    assertedFromCatalog: true,
    disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
}));
const failClaimedNotOffered = capture(() => variants.assertModelVariantsDisclosure({
    acceptedVariants: ['onnx-q8', 'mediapipe-cpu'],
    observedCatalogVariantKeys: observed,
    otherCatalogVariantsOffered: false,
    otherModelVariantsMeasured: false,
    verifiedGpuWhenOfferedMeasured: false,
    assertedFromCatalog: true,
    disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
}));
const failMeasured = capture(() => variants.assertModelVariantsDisclosure({
    ...report,
    otherModelVariantsMeasured: true,
}));
const failExtraAccepted = capture(() => variants.assertModelVariantsDisclosure({
    ...report,
    acceptedVariants: ['onnx-q8', 'mediapipe-cpu', 'onnx-q8f16'],
}));
console.log(JSON.stringify({
    needle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
    accepted: variants.ACCEPTED_MODEL_VARIANTS,
    requiredNonAccepted: variants.REQUIRED_NON_ACCEPTED_CATALOG_VARIANT,
    ok, report, nested,
    failNoQ8f16, failHardCodedNoEvidence, failClaimedNotOffered,
    failMeasured, failExtraAccepted,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('Model variants disclosure acceptance (KE-53)', () => {
    test('asserts from catalog evidence including onnx-q8f16', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.needle).toMatch(/other catalog variants not measured/);
        expect(snap.accepted).toEqual(['mediapipe-cpu', 'onnx-q8']);
        expect(snap.requiredNonAccepted).toBe('onnx-q8f16');
        expect(snap.ok).toEqual(expect.objectContaining({
            success: true,
            acceptedVariants: ['mediapipe-cpu', 'onnx-q8'],
            otherCatalogVariantsOffered: true,
            otherModelVariantsMeasured: false,
            verifiedGpuWhenOfferedMeasured: false,
            assertedFromCatalog: true,
        }));
        expect(snap.ok.observedCatalogVariantKeys).toEqual(
            expect.arrayContaining(['onnx-q8', 'mediapipe-cpu', 'onnx-q8f16']));
        expect(snap.ok.nonAcceptedCatalogVariants).toEqual(
            expect.arrayContaining(['onnx-q8f16']));
        expect(snap.report.assertedFromCatalog).toBe(true);
        expect(snap.report.otherCatalogVariantsOffered).toBe(true);
        expect(snap.nested.success).toBe(true);
        expect(snap.failNoQ8f16.ok).toBe(false);
        expect(snap.failNoQ8f16.message).toMatch(/onnx-q8f16/i);
        expect(snap.failHardCodedNoEvidence.ok).toBe(false);
        expect(snap.failHardCodedNoEvidence.message).toMatch(
            /observedCatalogVariantKeys/i);
        expect(snap.failClaimedNotOffered.ok).toBe(false);
        expect(snap.failClaimedNotOffered.message).toMatch(
            /otherCatalogVariantsOffered must be true/i);
        expect(snap.failMeasured.ok).toBe(false);
        expect(snap.failExtraAccepted.ok).toBe(false);
    });

    test('dual Chromium + Firefox observe catalog before assert', () => {
        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        const chromium = fs.readFileSync(chromiumLive, 'utf8');

        expect(firefox).toContain('observeCatalogVariantKeys');
        expect(firefox).toContain('observedCatalogVariantKeys');
        expect(firefox).toContain('assert_model_variants_disclosure');
        expect(chromium).toContain('listModelVariants');
        expect(chromium).toContain('observeCatalogVariantKeys');
        expect(chromium).toContain('observedCatalogVariantKeys');
        expect(chromium).toContain('assertModelVariantsDisclosure');
        expect(chromium).toContain('assertedFromCatalog');
        expect(chromium).toMatch(
            /observeCatalogVariantKeys\(\s*listModelVariants\(\)\s*\)/);
        expect(chromium).toContain('assertModelVariantsDisclosure(');
    });

    test('real model-catalog.js listModelVariants includes onnx-q8f16', () => {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as variants from ${JSON.stringify(helperUrl)};
const catalogFile = path.join(tmpdir(), 'kokoro-jest-model-variants-catalog.mjs');
writeFileSync(catalogFile, readFileSync(path.join(${JSON.stringify(root)}, 'model-catalog.js')));
const catalog = await import(pathToFileURL(catalogFile).href);
const keys = variants.observeCatalogVariantKeys(catalog.listModelVariants());
const report = variants.buildModelVariantsDisclosureReport({
    browser: 'jest',
    observedCatalogVariantKeys: keys,
});
variants.assertModelVariantsDisclosure(report);
console.log(JSON.stringify({ keys, assertedFromCatalog: report.assertedFromCatalog }));
`], { encoding: 'utf8', cwd: root });
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.keys).toEqual(expect.arrayContaining([
            'onnx-q8', 'mediapipe-cpu', 'onnx-q8f16',
        ]));
        expect(snap.assertedFromCatalog).toBe(true);
    });
});

