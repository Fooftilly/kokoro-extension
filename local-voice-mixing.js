// Local vs FastAPI voice-preference policy (#59).
// Classic script for popup + CommonJS for Jest. No network I/O.
(function () {
    'use strict';

    const DEFAULT_LOCAL_VOICE = 'af_heart';
    const LOCAL_VOICE_ID_RE = /^[a-z]{2}_[a-z]+$/;

    function normalizeLocalVoiceId(value) {
        if (typeof value !== 'string') return DEFAULT_LOCAL_VOICE;
        const trimmed = value.trim().toLowerCase();
        return LOCAL_VOICE_ID_RE.test(trimmed) ? trimmed : DEFAULT_LOCAL_VOICE;
    }

    function isLocalBackend(backend) {
        return backend === 'mediapipe' || backend === 'onnx';
    }

    /**
     * Official MediaPipe TextToSpeech exposes a single SynthesisOptions.voiceId
     * (no blend). ONNX catalog currently ships one voice binary (voices/af.bin);
     * style-vector interpolation exists in onnx-kokoro-inputs.js for future
     * multi-voice assets but is not a high-level runtime mixer yet.
     */
    function weightedMixingSupported(backend) {
        return backend === 'fastapi';
    }

    function localVoiceLimitationNote(backend) {
        if (backend === 'mediapipe') {
            return 'MediaPipe accepts one voice ID per utterance (official SynthesisOptions.voiceId). ' +
                'Weighted mixes such as af_sarah(5)+af_nicole(3) apply only to the Kokoro server. ' +
                'Your server voice mixer is stored separately and is never discarded when using MediaPipe.';
        }
        if (backend === 'onnx') {
            return 'ONNX uses the installed voice asset (currently voices/af.bin). ' +
                'Weighted FastAPI mixes are not applied on-device. Server mixer preferences stay saved separately. ' +
                'Low-level style-vector blending is available in-repo for future multi-voice downloads; ' +
                'do not mix PCM from multiple full syntheses.';
        }
        return '';
    }

    function resolvePlaybackVoice(backend, settings) {
        const source = settings && typeof settings === 'object' ? settings : {};
        if (isLocalBackend(backend)) {
            return {
                kind: 'local-single',
                voiceId: normalizeLocalVoiceId(source.localVoice),
                // FastAPI mix string must remain untouched by local playback.
                preservedServerVoice: typeof source.voice === 'string' ? source.voice : '',
            };
        }
        return {
            kind: 'fastapi-mix',
            voice: typeof source.voice === 'string' ? source.voice : '',
        };
    }

    const api = Object.freeze({
        DEFAULT_LOCAL_VOICE,
        LOCAL_VOICE_ID_RE,
        normalizeLocalVoiceId,
        isLocalBackend,
        weightedMixingSupported,
        localVoiceLimitationNote,
        resolvePlaybackVoice,
    });

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalThis.KokoroLocalVoiceMixing = api;
})();
