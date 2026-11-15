// #61 / KE-41a — honest GPU inference disclosure for capability preflight.
// WebGPU adapter presence is not product GPU inference. Classic script + CJS.
(function () {
    'use strict';

    /** Lowercase needle for acceptance asserts (popup cards share similar copy). */
    const GPU_INFERENCE_NOT_OFFERED_NEEDLE = 'gpu inference is not offered';

    /**
     * Disclose that MediaPipe/WebGPU GPU inference is not offered or measured
     * until a verified GPU execution path exists. Adapter status is recorded
     * only as context — never as evidence of offered GPU inference.
     *
     * @param {object|string|null|undefined} webgpuStatus
     * @returns {{
     *   gpuInferenceOffered: false,
     *   gpuInferenceMeasured: false,
     *   webgpuAdapterStatus: string,
     *   disclosureNeedle: string
     * }}
     */
    function discloseGpuInferenceOffer(webgpuStatus) {
        let adapterStatus = 'unknown';
        if (webgpuStatus && typeof webgpuStatus === 'object' &&
            webgpuStatus.status != null) {
            adapterStatus = String(webgpuStatus.status);
        } else if (typeof webgpuStatus === 'string' && webgpuStatus) {
            adapterStatus = webgpuStatus;
        }
        return {
            gpuInferenceOffered: false,
            gpuInferenceMeasured: false,
            webgpuAdapterStatus: adapterStatus,
            disclosureNeedle: GPU_INFERENCE_NOT_OFFERED_NEEDLE,
        };
    }

    const api = Object.freeze({
        GPU_INFERENCE_NOT_OFFERED_NEEDLE,
        discloseGpuInferenceOffer,
    });

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof globalThis !== 'undefined') {
        globalThis.KokoroGpuExecutionDisclosure = api;
    }
})();
