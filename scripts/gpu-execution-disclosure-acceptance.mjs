/**
 * #61 / KE-41a — GPU execution-path disclosure for dual-scope acceptance.
 * MediaPipe/WebGPU GPU inference is not offered or measured until verified.
 * Shared by Firefox dual live harness (Node bridge) + Jest contracts.
 */

export const GPU_INFERENCE_NOT_OFFERED_NEEDLE = 'gpu inference is not offered';

/**
 * Assert a capabilities / dual report discloses GPU inference as not offered
 * and not measured. Accepts either a full preflight (with `gpuInference`) or
 * a standalone disclosure block.
 *
 * @param {object} report
 * @returns {{
 *   success: true,
 *   gpuInferenceOffered: false,
 *   gpuInferenceMeasured: false,
 *   webgpuAdapterStatus: string,
 *   disclosureNeedle: string
 * }}
 */
export function assertGpuExecutionDisclosure(report) {
    if (!report || typeof report !== 'object') {
        throw Error('GPU execution disclosure report missing');
    }
    const block = report.gpuInference && typeof report.gpuInference === 'object'
        ? report.gpuInference
        : report;
    if (block.gpuInferenceOffered !== false) {
        throw Error(
            'GPU inference must not be offered until a verified path exists: ' +
            JSON.stringify(block));
    }
    if (block.gpuInferenceMeasured !== false) {
        throw Error(
            'GPU inference must not be reported as measured: ' +
            JSON.stringify(block));
    }
    const needle = String(block.disclosureNeedle || '').toLowerCase();
    if (!needle.includes(GPU_INFERENCE_NOT_OFFERED_NEEDLE)) {
        throw Error(
            'GPU disclosure needle missing from disclosureNeedle: ' +
            JSON.stringify(block.disclosureNeedle));
    }
    const haystack = JSON.stringify(block).toLowerCase();
    if (!haystack.includes(GPU_INFERENCE_NOT_OFFERED_NEEDLE)) {
        throw Error(
            'GPU disclosure text missing from report block: ' +
            JSON.stringify(block));
    }
    return {
        success: true,
        gpuInferenceOffered: false,
        gpuInferenceMeasured: false,
        webgpuAdapterStatus: String(block.webgpuAdapterStatus || 'unknown'),
        disclosureNeedle: GPU_INFERENCE_NOT_OFFERED_NEEDLE,
    };
}

export function buildGpuExecutionDisclosureReport(options = {}) {
    return {
        success: options.success !== false,
        browser: options.browser || 'unknown',
        gpuInferenceOffered: false,
        gpuInferenceMeasured: false,
        webgpuAdapterStatus: options.webgpuAdapterStatus || 'unknown',
        disclosureNeedle: GPU_INFERENCE_NOT_OFFERED_NEEDLE,
        assertedFromPreflight: options.assertedFromPreflight !== false,
    };
}
