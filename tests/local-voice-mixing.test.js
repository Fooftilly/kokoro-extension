'use strict';

const LocalVoice = require('../local-voice-mixing.js');

describe('local voice mixing policy (#59)', () => {
    test('normalizes MediaPipe voice IDs and rejects mixes', () => {
        expect(LocalVoice.normalizeLocalVoiceId('AF_Heart')).toBe('af_heart');
        expect(LocalVoice.normalizeLocalVoiceId('af_sarah(5)+af_nicole(3)')).toBe('af_heart');
        expect(LocalVoice.normalizeLocalVoiceId('')).toBe('af_heart');
    });

    test('FastAPI keeps weighted mixing; local backends do not', () => {
        expect(LocalVoice.weightedMixingSupported('fastapi')).toBe(true);
        expect(LocalVoice.weightedMixingSupported('mediapipe')).toBe(false);
        expect(LocalVoice.weightedMixingSupported('onnx')).toBe(false);
    });

    test('MediaPipe and ONNX prefs are distinct from the FastAPI mix', () => {
        const settings = {
            voice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
            mediaPipeVoice: 'af_bella',
            onnxVoiceAsset: 'voices/af.bin',
        };
        expect(LocalVoice.resolvePlaybackVoice('mediapipe', settings)).toEqual({
            kind: 'mediapipe-single',
            voiceId: 'af_bella',
            preservedServerVoice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
        });
        expect(LocalVoice.resolvePlaybackVoice('onnx', settings)).toEqual({
            kind: 'onnx-fixed-asset',
            voiceAsset: 'voices/af.bin',
            preservedServerVoice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
        });
        expect(LocalVoice.resolvePlaybackVoice('fastapi', settings)).toEqual({
            kind: 'fastapi-mix',
            voice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
        });
    });

    test('mediaPipeVoice falls back to legacy localVoice once', () => {
        expect(LocalVoice.mediaPipeVoiceFromSettings({ localVoice: 'af_sky' })).toBe('af_sky');
        expect(LocalVoice.mediaPipeVoiceFromSettings({
            mediaPipeVoice: 'af_bella',
            localVoice: 'af_sky',
        })).toBe('af_bella');
    });

    test('onnxVoiceAsset defaults to the catalog-fixed af.bin path', () => {
        expect(LocalVoice.onnxVoiceAssetFromSettings({})).toBe('voices/af.bin');
        expect(LocalVoice.ONNX_FIXED_VOICE_ASSET).toBe('voices/af.bin');
    });

    test('limitation notes disclose single-voice local behavior', () => {
        expect(LocalVoice.localVoiceLimitationNote('mediapipe')).toMatch(/SynthesisOptions\.voiceId/);
        expect(LocalVoice.localVoiceLimitationNote('onnx')).toMatch(/af\.bin/);
        expect(LocalVoice.localVoiceLimitationNote('onnx')).toMatch(/no effect/i);
        expect(LocalVoice.localVoiceLimitationNote('fastapi')).toBe('');
    });
});
