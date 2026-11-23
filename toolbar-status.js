/**
 * Backend-aware toolbar icon / title helpers (#208).
 * Classic script (Chrome SW + Firefox background + Jest). No network, no model load.
 */
(function () {
    'use strict';

    const KIND = Object.freeze({
        READY: 'ready',
        UNREACHABLE: 'unreachable',
        NEEDS_SETUP: 'needs_setup',
        /** Cache / catalog prerequisites missing so readiness cannot be evaluated. */
        UNAVAILABLE: 'unavailable',
        /** Probe threw or status check failed after prerequisites were present. */
        FAILED: 'failed',
        UNKNOWN: 'unknown',
    });

    const LABELS = Object.freeze({
        fastapi: 'Kokoro server',
        mediapipe: 'MediaPipe',
        onnx: 'ONNX',
    });

    function backendLabel(backend) {
        return LABELS[backend] || 'Kokoro TTS';
    }

    /**
     * Map readiness kind → icon paths.
     * Ready → green. FastAPI unreachable → red (server-disconnected).
     * Local setup gaps / unavailable / failed / unknown → default icons (never falsely green).
     */
    function iconPathsForKind(kind) {
        if (kind === KIND.READY) {
            return {
                48: 'icons/icon-48-green.png',
                128: 'icons/icon-128-green.png',
            };
        }
        if (kind === KIND.UNREACHABLE) {
            return {
                48: 'icons/icon-48-red.png',
                128: 'icons/icon-128-red.png',
            };
        }
        return {
            48: 'icons/icon48.png',
            128: 'icons/icon128.png',
        };
    }

    function titleForStatus({ kind, backend, detail } = {}) {
        const label = backendLabel(backend);
        if (kind === KIND.READY) {
            if (backend === 'fastapi') return label + ' reachable';
            return label + ' ready (on-device)';
        }
        if (kind === KIND.UNREACHABLE) {
            return label + ' unreachable';
        }
        if (kind === KIND.NEEDS_SETUP) {
            const reason = detail ? String(detail) : 'needs setup';
            return label + ': ' + reason + ' — open Test TTS backends';
        }
        if (kind === KIND.UNAVAILABLE) {
            const reason = detail ? String(detail) : 'unavailable';
            return label + ' unavailable: ' + reason;
        }
        if (kind === KIND.FAILED) {
            const reason = detail ? String(detail) : 'status check failed';
            return label + ' failed: ' + reason;
        }
        return 'Kokoro TTS status unknown';
    }

    /**
     * Classify local-engine readiness from read-only probe fields.
     * Never marks ready when validation or install state is incomplete/unknown.
     */
    function classifyLocalReadiness({
        backend,
        validatedRevision,
        expectedRevision,
        modelReady,
        dictionaryReady,
        optionalVoiceRequired,
        voiceReady,
    } = {}) {
        if (!backend || (backend !== 'mediapipe' && backend !== 'onnx')) {
            return { kind: KIND.UNKNOWN, backend, detail: 'unsupported local backend' };
        }
        if (!expectedRevision) {
            return { kind: KIND.UNAVAILABLE, backend, detail: 'model revision unavailable' };
        }
        if (!validatedRevision) {
            return {
                kind: KIND.NEEDS_SETUP,
                backend,
                detail: backend === 'onnx'
                    ? 'test ONNX q8 with English text first'
                    : 'test the installed model first',
            };
        }
        if (validatedRevision !== expectedRevision) {
            return {
                kind: KIND.NEEDS_SETUP,
                backend,
                detail: 'model revision changed — retest',
            };
        }
        if (modelReady !== true) {
            if (modelReady === false) {
                return {
                    kind: KIND.NEEDS_SETUP,
                    backend,
                    detail: 'model not installed',
                };
            }
            return { kind: KIND.UNKNOWN, backend, detail: 'model install state unknown' };
        }
        if (backend === 'onnx' && dictionaryReady !== true) {
            if (dictionaryReady === false) {
                return {
                    kind: KIND.NEEDS_SETUP,
                    backend,
                    detail: 'English dictionary not installed',
                };
            }
            return { kind: KIND.UNKNOWN, backend, detail: 'dictionary state unknown' };
        }
        if (optionalVoiceRequired) {
            if (voiceReady !== true) {
                if (voiceReady === false) {
                    return {
                        kind: KIND.NEEDS_SETUP,
                        backend,
                        detail: 'selected ONNX voice not installed',
                    };
                }
                return { kind: KIND.UNKNOWN, backend, detail: 'voice install state unknown' };
            }
        }
        return { kind: KIND.READY, backend, detail: null };
    }

    function isValidatedRevisionStorageKey(key) {
        return typeof key === 'string' && /ValidatedRevision/.test(key);
    }

    const api = Object.freeze({
        KIND,
        iconPathsForKind,
        titleForStatus,
        classifyLocalReadiness,
        isValidatedRevisionStorageKey,
        backendLabel,
    });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalThis.KokoroToolbarStatus = api;
})();
