/**
 * #57 / #61 / KE-53 — other model variants + verified-GPU-when-offered disclosure.
 * Dual scopes accept only onnx-q8 + MediaPipe CPU. fp16/int8/WebGPU-GPU/etc.
 * are not offered or measured; verified GPU when offered remains unmeasured.
 * Shared by Chromium + Firefox dual live harnesses + Jest contracts.
 */

export const ACCEPTED_MODEL_VARIANTS = Object.freeze(['mediapipe-cpu', 'onnx-q8']);

export const MODEL_VARIANTS_DISCLOSURE_NEEDLE =
    'other model variants not offered; verified GPU when offered not measured';

function normalizeAcceptedVariants(raw) {
    if (!Array.isArray(raw)) return null;
    return [...new Set(raw.map(item => String(item)))].sort();
}

/**
 * Assert a dual / disclosure report admits only onnx-q8 + mediapipe-cpu and
 * discloses other variants / verified-GPU-when-offered as not offered/measured.
 * Accepts either a nested `modelVariants` block or a standalone disclosure.
 *
 * @param {object} report
 * @returns {{
 *   success: true,
 *   acceptedVariants: string[],
 *   otherModelVariantsOffered: false,
 *   otherModelVariantsMeasured: false,
 *   verifiedGpuWhenOfferedMeasured: false,
 *   disclosureNeedle: string
 * }}
 */
export function assertModelVariantsDisclosure(report) {
    if (!report || typeof report !== 'object') {
        throw Error('Model variants disclosure report missing');
    }
    const block = report.modelVariants && typeof report.modelVariants === 'object'
        ? report.modelVariants
        : report;

    const accepted = normalizeAcceptedVariants(block.acceptedVariants);
    if (!accepted) {
        throw Error(
            'acceptedVariants must be an array of documented keys: ' +
            JSON.stringify(block.acceptedVariants));
    }
    const expected = [...ACCEPTED_MODEL_VARIANTS].sort();
    if (accepted.length !== expected.length ||
        accepted.some((key, index) => key !== expected[index])) {
        throw Error(
            'acceptedVariants must be exactly onnx-q8 + mediapipe-cpu: ' +
            JSON.stringify(block.acceptedVariants));
    }

    if (block.otherModelVariantsOffered !== false) {
        throw Error(
            'Other model variants (fp16/int8/WebGPU-GPU/etc.) must not be offered: ' +
            JSON.stringify(block));
    }
    if (block.otherModelVariantsMeasured !== false) {
        throw Error(
            'Other model variants must not be reported as measured: ' +
            JSON.stringify(block));
    }
    if (block.verifiedGpuWhenOfferedMeasured !== false) {
        throw Error(
            'Verified GPU when offered must not be reported as measured: ' +
            JSON.stringify(block));
    }

    const needleLower = MODEL_VARIANTS_DISCLOSURE_NEEDLE.toLowerCase();
    const needle = String(block.disclosureNeedle || '').toLowerCase();
    if (!needle.includes(needleLower)) {
        throw Error(
            'Model variants disclosure needle missing from disclosureNeedle: ' +
            JSON.stringify(block.disclosureNeedle));
    }
    const haystack = JSON.stringify(block).toLowerCase();
    if (!haystack.includes(needleLower)) {
        throw Error(
            'Model variants disclosure text missing from report block: ' +
            JSON.stringify(block));
    }

    return {
        success: true,
        acceptedVariants: expected,
        otherModelVariantsOffered: false,
        otherModelVariantsMeasured: false,
        verifiedGpuWhenOfferedMeasured: false,
        disclosureNeedle: MODEL_VARIANTS_DISCLOSURE_NEEDLE,
    };
}

export function buildModelVariantsDisclosureReport(options = {}) {
    return {
        success: options.success !== false,
        browser: options.browser || 'unknown',
        acceptedVariants: [...ACCEPTED_MODEL_VARIANTS],
        otherModelVariantsOffered: false,
        otherModelVariantsMeasured: false,
        verifiedGpuWhenOfferedMeasured: false,
        disclosureNeedle: MODEL_VARIANTS_DISCLOSURE_NEEDLE,
        assertedFromDual: options.assertedFromDual !== false,
    };
}
