// Common backend IDs, designed for Chrome classic workers, Firefox background pages and Jest.
(function () {
    'use strict';
    const FASTAPI = 'fastapi';
    const MEDIAPIPE = 'mediapipe';
    const ONNX = 'onnx';
    const KNOWN = Object.freeze([FASTAPI, MEDIAPIPE, ONNX]);
    const LABELS = Object.freeze({
        fastapi: 'Kokoro-FastAPI server',
        mediapipe: 'MediaPipe Kokoro (on device)',
        onnx: 'Kokoro ONNX Runtime (on device)',
    });

    function resolveBackend(value) {
        if (value === null || value === undefined || value === '') {
            return FASTAPI;
        }
        if (!KNOWN.includes(value)) {
            // Never interpret an unrecognized explicit selection as permission to use a server.
            throw new Error('Unknown Kokoro TTS backend: ' + String(value));
        }
        return value;
    }

    function unavailableResponse(value) {
        const backend = resolveBackend(value);
        if (backend === FASTAPI) {
            throw new Error('FastAPI is handled by the existing server provider');
        }
        return {
            success: false,
            kind: 'local-backend-not-installed',
            backend,
            error: LABELS[backend] + ' is not yet installed in this extension build. No text was sent to a server.',
        };
    }

    const api = Object.freeze({ FASTAPI, MEDIAPIPE, ONNX, KNOWN, LABELS, resolveBackend, unavailableResponse });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalThis.KokoroTtsProviders = api;
})();
