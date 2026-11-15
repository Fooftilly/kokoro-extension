/** @jest-environment node */
/**
 * Contract for other model variants / verified-GPU-when-offered disclosure
 * (#57 / #61 / KE-53). Dual scopes accept only onnx-q8 + MediaPipe CPU.
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

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as variants from ${JSON.stringify(helperUrl)};
const ok = variants.assertModelVariantsDisclosure({
    acceptedVariants: ['onnx-q8', 'mediapipe-cpu'],
    otherModelVariantsOffered: false,
    otherModelVariantsMeasured: false,
    verifiedGpuWhenOfferedMeasured: false,
    disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
});
const report = variants.buildModelVariantsDisclosureReport({
    browser: 'Firefox',
});
const nested = variants.assertModelVariantsDisclosure({
    modelVariants: {
        acceptedVariants: ['mediapipe-cpu', 'onnx-q8'],
        otherModelVariantsOffered: false,
        otherModelVariantsMeasured: false,
        verifiedGpuWhenOfferedMeasured: false,
        disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
    },
});
const failExtraVariant = (() => {
    try {
        variants.assertModelVariantsDisclosure({
            acceptedVariants: ['onnx-q8', 'mediapipe-cpu', 'onnx-q8f16'],
            otherModelVariantsOffered: false,
            otherModelVariantsMeasured: false,
            verifiedGpuWhenOfferedMeasured: false,
            disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failOffered = (() => {
    try {
        variants.assertModelVariantsDisclosure({
            acceptedVariants: ['onnx-q8', 'mediapipe-cpu'],
            otherModelVariantsOffered: true,
            otherModelVariantsMeasured: false,
            verifiedGpuWhenOfferedMeasured: false,
            disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failMeasured = (() => {
    try {
        variants.assertModelVariantsDisclosure({
            acceptedVariants: ['onnx-q8', 'mediapipe-cpu'],
            otherModelVariantsOffered: false,
            otherModelVariantsMeasured: true,
            verifiedGpuWhenOfferedMeasured: false,
            disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failGpuWhenOffered = (() => {
    try {
        variants.assertModelVariantsDisclosure({
            acceptedVariants: ['onnx-q8', 'mediapipe-cpu'],
            otherModelVariantsOffered: false,
            otherModelVariantsMeasured: false,
            verifiedGpuWhenOfferedMeasured: true,
            disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failNeedle = (() => {
    try {
        variants.assertModelVariantsDisclosure({
            acceptedVariants: ['onnx-q8', 'mediapipe-cpu'],
            otherModelVariantsOffered: false,
            otherModelVariantsMeasured: false,
            verifiedGpuWhenOfferedMeasured: false,
            disclosureNeedle: 'variants ok',
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    needle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
    accepted: variants.ACCEPTED_MODEL_VARIANTS,
    ok, report, nested,
    failExtraVariant, failOffered, failMeasured, failGpuWhenOffered, failNeedle,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('Model variants disclosure acceptance (KE-53)', () => {
    test('shared acceptance helper asserts and builds dual report', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.needle).toBe(
            'other model variants not offered; verified GPU when offered not measured');
        expect(snap.accepted).toEqual(['mediapipe-cpu', 'onnx-q8']);
        expect(snap.ok).toEqual(expect.objectContaining({
            success: true,
            acceptedVariants: ['mediapipe-cpu', 'onnx-q8'],
            otherModelVariantsOffered: false,
            otherModelVariantsMeasured: false,
            verifiedGpuWhenOfferedMeasured: false,
        }));
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            browser: 'Firefox',
            acceptedVariants: ['mediapipe-cpu', 'onnx-q8'],
            otherModelVariantsOffered: false,
            otherModelVariantsMeasured: false,
            verifiedGpuWhenOfferedMeasured: false,
            assertedFromDual: true,
        }));
        expect(snap.nested.success).toBe(true);
        expect(snap.failExtraVariant.ok).toBe(false);
        expect(snap.failExtraVariant.message).toMatch(/exactly onnx-q8/i);
        expect(snap.failOffered.ok).toBe(false);
        expect(snap.failOffered.message).toMatch(/must not be offered/i);
        expect(snap.failMeasured.ok).toBe(false);
        expect(snap.failMeasured.message).toMatch(/must not be reported as measured/i);
        expect(snap.failGpuWhenOffered.ok).toBe(false);
        expect(snap.failGpuWhenOffered.message).toMatch(
            /Verified GPU when offered must not be reported as measured/i);
        expect(snap.failNeedle.ok).toBe(false);
        expect(snap.failNeedle.message).toMatch(/needle missing/i);
    });

    test('source wiring: dual Chromium + Firefox assert exclusive module', () => {
        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        const chromium = fs.readFileSync(chromiumLive, 'utf8');

        expect(firefox).toContain('model-variants-disclosure-acceptance.mjs');
        expect(firefox).toContain('assert_model_variants_disclosure');
        expect(firefox).toContain('modelVariantsDisclosureAcceptance');
        const dualGate = firefox.indexOf('if dual_comparison:');
        const gpuCall = firefox.indexOf(
            'assert_gpu_execution_disclosure(\n                    preflight');
        const variantsCall = firefox.indexOf(
            'model_variants_disclosure = assert_model_variants_disclosure(');
        const popupCall = firefox.indexOf(
            'accept_popup_test_tts_cta(driver, state["origin"])');
        expect(dualGate).toBeGreaterThan(0);
        expect(gpuCall).toBeGreaterThan(dualGate);
        expect(variantsCall).toBeGreaterThan(gpuCall);
        expect(popupCall).toBeGreaterThan(variantsCall);

        expect(chromium).toContain('model-variants-disclosure-acceptance.mjs');
        expect(chromium).toContain('assertModelVariantsDisclosure');
        expect(chromium).toContain('buildModelVariantsDisclosureReport');
        expect(chromium).toContain('modelVariantsDisclosureAcceptance');
        const chromiumDualGate = chromium.indexOf(
            "providerFilter === 'both' && !originDownload");
        const chromiumGpu = chromium.indexOf(
            'assertGpuExecutionDisclosure(preflight)');
        const chromiumVariants = chromium.indexOf(
            'assertModelVariantsDisclosure(');
        const chromiumPopup = chromium.indexOf(
            'liveHeartbeat(\'popup-test-tts-cta-start\')');
        expect(chromiumDualGate).toBeGreaterThan(0);
        expect(chromiumGpu).toBeGreaterThan(chromiumDualGate);
        expect(chromiumVariants).toBeGreaterThan(chromiumGpu);
        expect(chromiumPopup).toBeGreaterThan(chromiumVariants);
    });

    test('assert fails closed when dual omits honesty flags or claims variants', () => {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as variants from ${JSON.stringify(helperUrl)};
const omit = (() => {
    try {
        variants.assertModelVariantsDisclosure({
            wasmCompilation: true,
            webgpu: { status: 'adapter-available' },
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const gpuOnly = (() => {
    try {
        variants.assertModelVariantsDisclosure({
            acceptedVariants: ['onnx-q8', 'mediapipe-cpu'],
            otherModelVariantsOffered: false,
            otherModelVariantsMeasured: false,
            // verifiedGpuWhenOfferedMeasured omitted
            disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const mediapipeGpu = (() => {
    try {
        variants.assertModelVariantsDisclosure({
            acceptedVariants: ['mediapipe-gpu', 'onnx-q8'],
            otherModelVariantsOffered: false,
            otherModelVariantsMeasured: false,
            verifiedGpuWhenOfferedMeasured: false,
            disclosureNeedle: variants.MODEL_VARIANTS_DISCLOSURE_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({ omit, gpuOnly, mediapipeGpu }));
`], { encoding: 'utf8', cwd: root });
        expect(child.status).toBe(0);
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.omit.ok).toBe(false);
        expect(snap.omit.message).toMatch(/acceptedVariants|exactly onnx-q8/i);
        expect(snap.gpuOnly.ok).toBe(false);
        expect(snap.gpuOnly.message).toMatch(/Verified GPU when offered/i);
        expect(snap.mediapipeGpu.ok).toBe(false);
        expect(snap.mediapipeGpu.message).toMatch(/exactly onnx-q8/i);
    });
});
