'use strict';

const LocalVoice = require('../local-voice-mixing.js');

describe('local voice mixing policy (#59)', () => {
    test('normalizes local voice IDs and rejects mixes', () => {
        expect(LocalVoice.normalizeLocalVoiceId('AF_Heart')).toBe('af_heart');
        expect(LocalVoice.normalizeLocalVoiceId('af_sarah(5)+af_nicole(3)')).toBe('af_heart');
        expect(LocalVoice.normalizeLocalVoiceId('')).toBe('af_heart');
    });

    test('FastAPI keeps weighted mixing; local backends do not', () => {
        expect(LocalVoice.weightedMixingSupported('fastapi')).toBe(true);
        expect(LocalVoice.weightedMixingSupported('mediapipe')).toBe(false);
        expect(LocalVoice.weightedMixingSupported('onnx')).toBe(false);
    });

    test('resolvePlaybackVoice never rewrites the stored server mix for local backends', () => {
        const settings = {
            voice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
            localVoice: 'af_bella',
        };
        expect(LocalVoice.resolvePlaybackVoice('mediapipe', settings)).toEqual({
            kind: 'local-single',
            voiceId: 'af_bella',
            preservedServerVoice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
        });
        expect(LocalVoice.resolvePlaybackVoice('fastapi', settings)).toEqual({
            kind: 'fastapi-mix',
            voice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
        });
    });

    test('limitation notes disclose single-voice local behavior', () => {
        expect(LocalVoice.localVoiceLimitationNote('mediapipe')).toMatch(/SynthesisOptions\.voiceId/);
        expect(LocalVoice.localVoiceLimitationNote('onnx')).toMatch(/af\.bin/);
        expect(LocalVoice.localVoiceLimitationNote('fastapi')).toBe('');
    });
});
