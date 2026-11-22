/**
 * @jest-environment jsdom
 */
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
        expect(LocalVoice.mediaPipeVoiceFromSettings({ localVoice: 'af_bella' })).toBe('af_bella');
        expect(LocalVoice.mediaPipeVoiceFromSettings({
            mediaPipeVoice: 'af_sky',
            localVoice: 'af_bella',
        })).toBe('af_sky');
        expect(LocalVoice.mediaPipeVoiceFromSettings({})).toBe('af_heart');
    });

    test('onnxVoiceAsset defaults to the catalog-fixed af.bin path', () => {
        expect(LocalVoice.onnxVoiceAssetFromSettings({})).toBe('voices/af.bin');
        expect(LocalVoice.ONNX_FIXED_VOICE_ASSET).toBe('voices/af.bin');
        expect(LocalVoice.normalizeOnnxVoiceAsset('voices/af_bella.bin')).toBe('voices/af_bella.bin');
        expect(LocalVoice.normalizeOnnxVoiceAsset('voices/nope.bin')).toBe('voices/af.bin');
        expect(LocalVoice.ONNX_VOICE_ASSETS).toEqual(['voices/af.bin', 'voices/af_bella.bin']);
    });

    test('MediaPipe curated catalog lists 54 Kokoro-82M voice IDs (#194 item 6)', () => {
        expect(LocalVoice.MEDIAPIPE_VOICE_IDS).toHaveLength(54);
        expect(LocalVoice.MEDIAPIPE_VOICE_IDS).toContain('af_heart');
        expect(LocalVoice.MEDIAPIPE_VOICE_IDS).toContain('bf_emma');
        expect(LocalVoice.MEDIAPIPE_VOICE_IDS).toContain('zf_xiaobei');
        expect(LocalVoice.MEDIAPIPE_VOICE_IDS).toContain('jf_alpha');
        expect(new Set(LocalVoice.MEDIAPIPE_VOICE_IDS).size).toBe(54);
        expect(LocalVoice.isKnownMediaPipeVoice('af_bella')).toBe(true);
        expect(LocalVoice.isKnownMediaPipeVoice('xx_custom')).toBe(false);
    });

    test('populateMediaPipeVoiceSelect fills optgroups and preserves custom IDs', () => {
        document.body.innerHTML = '<select id="mediaPipeVoice"></select>';
        const selectEl = document.getElementById('mediaPipeVoice');

        expect(LocalVoice.populateMediaPipeVoiceSelect(selectEl, 'bf_emma')).toBe('bf_emma');
        expect(selectEl.value).toBe('bf_emma');
        expect(selectEl.querySelectorAll('optgroup').length).toBe(LocalVoice.MEDIAPIPE_VOICE_GROUPS.length);
        expect(selectEl.querySelectorAll('option').length).toBe(54);

        expect(LocalVoice.populateMediaPipeVoiceSelect(selectEl, 'xx_custom')).toBe('xx_custom');
        expect(selectEl.value).toBe('xx_custom');
        expect(selectEl.querySelector('optgroup[label="Custom"]')).toBeTruthy();
        expect(selectEl.querySelectorAll('option').length).toBe(55);
    });

    test('limitation notes disclose single-voice local behavior', () => {
        expect(LocalVoice.localVoiceLimitationNote('mediapipe')).toMatch(/SynthesisOptions\.voiceId/);
        expect(LocalVoice.localVoiceLimitationNote('onnx')).toMatch(/af\.bin/);
        expect(LocalVoice.localVoiceLimitationNote('onnx')).toMatch(/af_bella/);
        expect(LocalVoice.localVoiceLimitationNote('fastapi')).toBe('');
    });
});
