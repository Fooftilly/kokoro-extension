// Local vs FastAPI voice-preference policy (#59).
// Classic script for popup + CommonJS for Jest. No network I/O.
(function () {
    'use strict';

    const DEFAULT_MEDIAPIPE_VOICE = 'af_heart';
    /** Default ONNX voice binary (American English pack). */
    const ONNX_FIXED_VOICE_ASSET = 'voices/af.bin';
    /** Catalogued selectable ONNX voice paths (#60 voice-change first slice). */
    const ONNX_VOICE_ASSETS = Object.freeze(['voices/af.bin', 'voices/af_bella.bin']);
    const LOCAL_VOICE_ID_RE = /^[a-z]{2}_[a-z]+$/;

    function normalizeLocalVoiceId(value) {
        if (typeof value !== 'string') return DEFAULT_MEDIAPIPE_VOICE;
        const trimmed = value.trim().toLowerCase();
        return LOCAL_VOICE_ID_RE.test(trimmed) ? trimmed : DEFAULT_MEDIAPIPE_VOICE;
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
                'Your server voice mixer and ONNX voice asset preference are stored separately ' +
                'and are never discarded when using MediaPipe.';
        }
        if (backend === 'onnx') {
            return 'ONNX playback uses one catalogued voice asset at a time (' +
                ONNX_VOICE_ASSETS.join(' or ') + '). ' +
                'Choose the asset below; weighted FastAPI mixes and the MediaPipe voice ID stay ' +
                'saved separately. Style-vector blending remains available in-repo for future ' +
                'mixes; do not mix PCM from multiple full syntheses.';
        }
        return '';
    }

    /** Prefer mediaPipeVoice; fall back to legacy shared localVoice once. */
    function mediaPipeVoiceFromSettings(settings) {
        const source = settings && typeof settings === 'object' ? settings : {};
        if (typeof source.mediaPipeVoice === 'string' && source.mediaPipeVoice.trim()) {
            return normalizeLocalVoiceId(source.mediaPipeVoice);
        }
        return normalizeLocalVoiceId(source.localVoice);
    }

    function normalizeOnnxVoiceAsset(value) {
        if (typeof value !== 'string') return ONNX_FIXED_VOICE_ASSET;
        const trimmed = value.trim();
        return ONNX_VOICE_ASSETS.includes(trimmed) ? trimmed : ONNX_FIXED_VOICE_ASSET;
    }

    function onnxVoiceAssetFromSettings(settings) {
        const source = settings && typeof settings === 'object' ? settings : {};
        return normalizeOnnxVoiceAsset(source.onnxVoiceAsset);
    }

    function resolvePlaybackVoice(backend, settings) {
        const source = settings && typeof settings === 'object' ? settings : {};
        const preservedServerVoice = typeof source.voice === 'string' ? source.voice : '';
        if (backend === 'mediapipe') {
            return {
                kind: 'mediapipe-single',
                voiceId: mediaPipeVoiceFromSettings(source),
                preservedServerVoice,
            };
        }
        if (backend === 'onnx') {
            return {
                kind: 'onnx-fixed-asset',
                voiceAsset: onnxVoiceAssetFromSettings(source),
                preservedServerVoice,
            };
        }
        return {
            kind: 'fastapi-mix',
            voice: preservedServerVoice,
        };
    }

    const api = Object.freeze({
        DEFAULT_MEDIAPIPE_VOICE,
        /** @deprecated use DEFAULT_MEDIAPIPE_VOICE */
        DEFAULT_LOCAL_VOICE: DEFAULT_MEDIAPIPE_VOICE,
        ONNX_FIXED_VOICE_ASSET,
        ONNX_VOICE_ASSETS,
        LOCAL_VOICE_ID_RE,
        normalizeLocalVoiceId,
        normalizeOnnxVoiceAsset,
        isLocalBackend,
        weightedMixingSupported,
        localVoiceLimitationNote,
        mediaPipeVoiceFromSettings,
        onnxVoiceAssetFromSettings,
        resolvePlaybackVoice,
    });

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    globalThis.KokoroLocalVoiceMixing = api;
})();
