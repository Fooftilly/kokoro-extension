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

    // Stable, JSON-serializable capability descriptors for background, popup,
    // and the eventual three-engine test page (#61). This is NOT a readiness
    // check: downloaded weights, browser GPU support, and an available server
    // must be verified by the respective provider at the time of use.
    const CAPABILITIES = Object.freeze({
        fastapi: Object.freeze({
            id: FASTAPI, label: LABELS.fastapi, execution: 'server',
            installation: 'external', readiness: 'requires-server-probe',
            textSynthesis: 'supported', phonemeSynthesis: 'not-exposed',
            outputFormats: Object.freeze(['mp3']),
            weightedVoiceMixing: true, availableVoices: 'query-server',
            modelStatus: 'external', supportsCancel: false,
        }),
        mediapipe: Object.freeze({
            id: MEDIAPIPE, label: LABELS.mediapipe, execution: 'on-device',
            installation: 'opt-in-model-download', readiness: 'requires-runtime-check',
            textSynthesis: 'experimental', phonemeSynthesis: 'not-exposed',
            outputFormats: Object.freeze(['wav']),
            weightedVoiceMixing: false, availableVoices: 'runtime-dependent',
            modelStatus: 'not-checked', supportsCancel: true,
        }),
        onnx: Object.freeze({
            id: ONNX, label: LABELS.onnx, execution: 'on-device',
            installation: 'opt-in-model-download', readiness: 'requires-runtime-check',
            // The graph/phoneme diagnostic is not normal article TTS until
            // the in-repository English G2P path is validated for production.
            textSynthesis: 'experimental', phonemeSynthesis: 'diagnostic-only',
            outputFormats: Object.freeze(['wav']),
            weightedVoiceMixing: false, availableVoices: 'model-assets',
            modelStatus: 'not-checked', supportsCancel: false,
        }),
    });

    function getCapabilities(value) {
        return CAPABILITIES[resolveBackend(value)];
    }

    function listCapabilities() {
        return KNOWN.map(id => getCapabilities(id));
    }

    // Resolve once at the boundary between saved preferences and playback.
    // Local engines must never receive the server URL, even when preferences
    // still contain a previously configured FastAPI endpoint.
    function resolvePlaybackConnection(value, apiUrl) {
        const backend = resolveBackend(value);
        if (backend !== FASTAPI) return { backend, apiUrl: null };
        if (typeof apiUrl !== 'string' || !apiUrl.trim()) {
            throw new Error('Configure a Kokoro server URL before using FastAPI.');
        }
        const trimmed = apiUrl.trim();
        return { backend, apiUrl: trimmed.endsWith('/') ? trimmed : trimmed + '/' };
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

    const api = Object.freeze({ FASTAPI, MEDIAPIPE, ONNX, KNOWN, LABELS, resolveBackend,
        unavailableResponse, getCapabilities, listCapabilities, resolvePlaybackConnection });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalThis.KokoroTtsProviders = api;
})();
