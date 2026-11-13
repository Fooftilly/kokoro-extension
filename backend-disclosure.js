// Popup / model-manager disclosure copy for the three TTS backends (#58).
// Classic script for popup + CommonJS for Jest. No network I/O.
(function () {
    'use strict';

    const CTA_LABEL = 'Test TTS backends';
    const CTA_HINT = 'Opens the extension test page to download models, compare backends, ' +
        'and choose one with Use this backend. Preference updates only when you confirm.';

    /** Packaged ONNX phoneme vocab/config embedded in phoneme-tokenizer.js (~3.5 KB). */
    const PACKAGED_ONNX_TOKENIZER_BYTES = 3500;
    const PACKAGED_ONNX_TOKENIZER_LABEL = '~3.5 KB';

    /** Numeric total phrase for UI: downloadable assets plus packaged tokenizer when ONNX. */
    function modelDataFootprintLabel(entry, formatBytes) {
        const source = entry && typeof entry === 'object' ? entry : {};
        const downloadBytes = Number.isSafeInteger(source.totalBytes) ? source.totalBytes : 0;
        const downloadLabel = typeof formatBytes === 'function'
            ? formatBytes(downloadBytes)
            : String(downloadBytes);
        if (source.provider === 'onnx') {
            return downloadLabel + ' + ' + PACKAGED_ONNX_TOKENIZER_LABEL +
                ' packaged tokenizer/config';
        }
        return downloadLabel;
    }

    function backendDisclosure(backend) {
        if (backend === 'mediapipe') {
            return 'MediaPipe runs on-device (CPU/WASM product path). Speech text never goes to the Kokoro server. ' +
                'Output is local WAV with a single voice ID — not remote MP3 or weighted FastAPI mixes. ' +
                'Supported language: English; voices are Kokoro voice IDs such as af_heart ' +
                '(many named embeddings ship inside the model bundle). ' +
                'CPU synthesis can be slower than real-time on some machines. ' +
                'MediaPipe GPU remains unverified until a WebGPU adapter is available and a successful test passes. ' +
                'Install and test models on the TTS backends page.';
        }
        if (backend === 'onnx') {
            return 'ONNX Runtime Web runs on-device via packaged WASM (CPU) in Chrome and Firefox. ' +
                'Speech text never goes to the Kokoro server and there is no server fallback. ' +
                'Output is local WAV using the fixed catalog voice asset voices/af.bin ' +
                '(American English style pack) — not remote MP3 or weighted mixes. ' +
                'Supported language: dictionary-backed US English only after the opt-in CMUdict download; ' +
                'unknown words fail locally. WebGPU ONNX is not offered. Install and test on the TTS backends page.';
        }
        if (backend === 'fastapi') {
            return 'Kokoro server (Docker / FastAPI) is the default for existing users. ' +
                'Selected text is sent to your configured API URL. Weighted voice mixes and stream/download MP3 remain available. ' +
                'Supported voices and languages come from your server\'s voice list. ' +
                'Switching away never deletes local MediaPipe or ONNX preferences.';
        }
        return 'Unknown saved backend. Select one explicitly; no server requests will run.';
    }

    function downloadFootprintNote(entry) {
        const source = entry && typeof entry === 'object' ? entry : {};
        if (source.provider === 'onnx') {
            return 'Total model-data footprint includes the opt-in download (ONNX graph + voices/af.bin) ' +
                'plus packaged tokenizer/config mapping (' + PACKAGED_ONNX_TOKENIZER_LABEL +
                ') already in the extension. English CMUdict is a separate ~3.5 MB opt-in download. ' +
                'Official ONNX Runtime JS/WASM is packaged locally — not part of model-data size.';
        }
        if (source.provider === 'mediapipe' && source.variant === 'gpu') {
            return 'GPU model download is experimental. Product-supported path is MediaPipe CPU (WASM). ' +
                'GPU inference stays unverified until a WebGPU adapter is available and a successful on-device test completes. ' +
                'Official MediaPipe WASM is packaged locally.';
        }
        if (source.provider === 'mediapipe') {
            return 'Download size is the LiteRT model. Official MediaPipe WASM is packaged locally. ' +
                'CPU synthesis may run slower than real-time on some machines.';
        }
        if (source.provider === 'dictionary') {
            return 'Optional English pronunciation dictionary for ONNX. Separate from the ONNX model download.';
        }
        return '';
    }

    const api = Object.freeze({
        CTA_LABEL,
        CTA_HINT,
        PACKAGED_ONNX_TOKENIZER_BYTES,
        PACKAGED_ONNX_TOKENIZER_LABEL,
        backendDisclosure,
        downloadFootprintNote,
        modelDataFootprintLabel,
    });

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalThis.KokoroBackendDisclosure = api;
})();
