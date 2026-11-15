/** @jest-environment node */
/**
 * Contract for GPU inference not-offered disclosure (#61 / KE-41a).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'gpu-execution-disclosure-acceptance.mjs')).href;
const disclosureModule = require('../gpu-execution-disclosure.js');
const { inspectCapabilities } = require('../benchmark-capabilities.js');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const capabilitiesSource = path.join(root, 'benchmark-capabilities.js');
const disclosureSource = path.join(root, 'gpu-execution-disclosure.js');
const buildSource = path.join(root, 'build.js');
const eslintSource = path.join(root, 'eslint.config.mjs');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as gpu from ${JSON.stringify(helperUrl)};
const ok = gpu.assertGpuExecutionDisclosure({
    gpuInference: {
        gpuInferenceOffered: false,
        gpuInferenceMeasured: false,
        webgpuAdapterStatus: 'adapter-available',
        disclosureNeedle: gpu.GPU_INFERENCE_NOT_OFFERED_NEEDLE,
    },
});
const report = gpu.buildGpuExecutionDisclosureReport({
    browser: 'Firefox',
    webgpuAdapterStatus: 'not-exposed',
});
const failOffered = (() => {
    try {
        gpu.assertGpuExecutionDisclosure({
            gpuInferenceOffered: true,
            gpuInferenceMeasured: false,
            webgpuAdapterStatus: 'adapter-available',
            disclosureNeedle: gpu.GPU_INFERENCE_NOT_OFFERED_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failMeasured = (() => {
    try {
        gpu.assertGpuExecutionDisclosure({
            gpuInferenceOffered: false,
            gpuInferenceMeasured: true,
            webgpuAdapterStatus: 'adapter-available',
            disclosureNeedle: gpu.GPU_INFERENCE_NOT_OFFERED_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    needle: gpu.GPU_INFERENCE_NOT_OFFERED_NEEDLE,
    ok, report, failOffered, failMeasured,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('GPU execution disclosure acceptance (KE-41a)', () => {
    test('discloseGpuInferenceOffer never offers or measures GPU inference', () => {
        const withAdapter = disclosureModule.discloseGpuInferenceOffer({
            status: 'adapter-available',
            features: ['shader-f16'],
        });
        const without = disclosureModule.discloseGpuInferenceOffer({
            status: 'not-exposed',
        });
        const stringStatus = disclosureModule.discloseGpuInferenceOffer(
            'request-failed');
        expect(withAdapter).toEqual({
            gpuInferenceOffered: false,
            gpuInferenceMeasured: false,
            webgpuAdapterStatus: 'adapter-available',
            disclosureNeedle: disclosureModule.GPU_INFERENCE_NOT_OFFERED_NEEDLE,
        });
        expect(without.gpuInferenceOffered).toBe(false);
        expect(without.gpuInferenceMeasured).toBe(false);
        expect(without.webgpuAdapterStatus).toBe('not-exposed');
        expect(stringStatus.webgpuAdapterStatus).toBe('request-failed');
        expect(withAdapter.disclosureNeedle).toContain('gpu inference is not offered');
    });

    test('inspectCapabilities wires gpuInference disclosure block', async () => {
        const report = await inspectCapabilities({
            navigator: {
                userAgent: 'Test Browser',
                gpu: {
                    requestAdapter: async () => ({
                        features: new Set(['shader-f16']),
                        limits: { maxBufferSize: 1024 },
                    }),
                },
            },
            WebAssembly: { compile: async () => {} },
            SharedArrayBuffer: class SharedArrayBuffer {},
            crossOriginIsolated: true,
            isSecureContext: true,
        });
        expect(report.webgpu.status).toBe('adapter-available');
        expect(report.gpuInference).toEqual({
            gpuInferenceOffered: false,
            gpuInferenceMeasured: false,
            webgpuAdapterStatus: 'adapter-available',
            disclosureNeedle: disclosureModule.GPU_INFERENCE_NOT_OFFERED_NEEDLE,
        });
        expect(report.inferenceValidated).toBe(false);
    });

    test('shared acceptance helper asserts and builds dual report', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.needle).toBe('gpu inference is not offered');
        expect(snap.ok).toEqual(expect.objectContaining({
            success: true,
            gpuInferenceOffered: false,
            gpuInferenceMeasured: false,
        }));
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            gpuInferenceOffered: false,
            gpuInferenceMeasured: false,
            assertedFromPreflight: true,
        }));
        expect(snap.failOffered.ok).toBe(false);
        expect(snap.failOffered.message).toMatch(/must not be offered/i);
        expect(snap.failMeasured.ok).toBe(false);
        expect(snap.failMeasured.message).toMatch(/must not be reported as measured/i);
    });

    test('source wiring: capabilities require disclosure + dual live asserts', () => {
        const capabilities = fs.readFileSync(capabilitiesSource, 'utf8');
        const disclosure = fs.readFileSync(disclosureSource, 'utf8');
        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        const chromium = fs.readFileSync(chromiumLive, 'utf8');
        const build = fs.readFileSync(buildSource, 'utf8');
        const eslint = fs.readFileSync(eslintSource, 'utf8');

        expect(disclosure).toContain('discloseGpuInferenceOffer');
        expect(disclosure).toContain('gpuInferenceOffered: false');
        expect(disclosure).toContain('gpuInferenceMeasured: false');
        expect(capabilities).toContain("require('./gpu-execution-disclosure.js')");
        expect(capabilities).toContain('gpuInference:');
        expect(capabilities).toContain('discloseGpuInferenceOffer(webgpu)');
        expect(build).toContain("'gpu-execution-disclosure.js'");
        expect(eslint).toContain("'gpu-execution-disclosure.js'");

        expect(firefox).toContain('gpu-execution-disclosure-acceptance.mjs');
        expect(firefox).toContain('assert_gpu_execution_disclosure');
        expect(firefox).toContain('gpuExecutionDisclosureAcceptance');
        const gpuCall = firefox.indexOf(
            'assert_gpu_execution_disclosure(\n                    preflight');
        const dualGate = firefox.indexOf('if dual_comparison:');
        const popupCall = firefox.indexOf(
            'accept_popup_test_tts_cta(driver, state["origin"])');
        expect(dualGate).toBeGreaterThan(0);
        expect(gpuCall).toBeGreaterThan(dualGate);
        expect(popupCall).toBeGreaterThan(gpuCall);

        // Chromium dual must assert against real preflight (not invent).
        expect(chromium).toContain('gpu-execution-disclosure-acceptance.mjs');
        expect(chromium).toContain('assertGpuExecutionDisclosure(preflight)');
        expect(chromium).toContain('gpuExecutionDisclosureAcceptance');
        expect(chromium).toContain('buildGpuExecutionDisclosureReport');
        const chromiumDualGate = chromium.indexOf(
            "providerFilter === 'both' && !originDownload");
        const chromiumGpuAssert = chromium.indexOf(
            'assertGpuExecutionDisclosure(preflight)');
        const chromiumPopup = chromium.indexOf(
            'liveHeartbeat(\'popup-test-tts-cta-start\')');
        expect(chromiumDualGate).toBeGreaterThan(0);
        expect(chromiumGpuAssert).toBeGreaterThan(chromiumDualGate);
        expect(chromiumPopup).toBeGreaterThan(chromiumGpuAssert);
    });

    test('assert fails closed when Chromium-style preflight omits gpuInference', () => {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as gpu from ${JSON.stringify(helperUrl)};
const omit = (() => {
    try {
        gpu.assertGpuExecutionDisclosure({
            wasmCompilation: true,
            webgpu: { status: 'adapter-available' },
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const falseOffer = (() => {
    try {
        gpu.assertGpuExecutionDisclosure({
            wasmCompilation: true,
            gpuInference: {
                gpuInferenceOffered: true,
                gpuInferenceMeasured: false,
                webgpuAdapterStatus: 'adapter-available',
                disclosureNeedle: gpu.GPU_INFERENCE_NOT_OFFERED_NEEDLE,
            },
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({ omit, falseOffer }));
`], { encoding: 'utf8', cwd: root });
        expect(child.status).toBe(0);
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.omit.ok).toBe(false);
        expect(snap.omit.message).toMatch(/must not be offered|needle missing/i);
        expect(snap.falseOffer.ok).toBe(false);
        expect(snap.falseOffer.message).toMatch(/must not be offered/i);
    });
});
