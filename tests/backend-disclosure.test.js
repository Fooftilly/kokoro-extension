'use strict';

const Disclosure = require('../backend-disclosure.js');

describe('backend disclosure copy (#58)', () => {
    test('CTA names the TTS backends test page', () => {
        expect(Disclosure.CTA_LABEL).toBe('Test TTS backends');
        expect(Disclosure.CTA_HINT).toMatch(/Use this backend/i);
    });

    test('disclosures cover privacy, device path, voices, and languages', () => {
        expect(Disclosure.backendDisclosure('fastapi')).toMatch(/configured API URL/i);
        expect(Disclosure.backendDisclosure('fastapi')).toMatch(/voice list/i);
        expect(Disclosure.backendDisclosure('mediapipe')).toMatch(/never goes to the Kokoro server/i);
        expect(Disclosure.backendDisclosure('mediapipe')).toMatch(/Supported language: English/i);
        expect(Disclosure.backendDisclosure('mediapipe')).toMatch(/af_heart/);
        expect(Disclosure.backendDisclosure('mediapipe')).toMatch(/slower than real-time/i);
        expect(Disclosure.backendDisclosure('mediapipe')).toMatch(/GPU.*unverified/i);
        expect(Disclosure.backendDisclosure('onnx')).toMatch(/WASM/i);
        expect(Disclosure.backendDisclosure('onnx')).toMatch(/never goes to the Kokoro server/i);
        expect(Disclosure.backendDisclosure('onnx')).toMatch(/af\.bin/);
        expect(Disclosure.backendDisclosure('onnx')).toMatch(/US English/i);
    });

    test('ONNX footprint total includes packaged tokenizer plus downloadable graph/voice', () => {
        const note = Disclosure.downloadFootprintNote({ provider: 'onnx', variant: 'q8' });
        expect(note).toMatch(/Total model-data footprint/i);
        expect(note).toMatch(/voices\/af\.bin/);
        expect(note).toMatch(/tokenizer\/config/i);
        expect(note).toMatch(/3\.5 KB/);
        expect(Disclosure.downloadFootprintNote({ provider: 'mediapipe', variant: 'gpu' }))
            .toMatch(/unverified/i);
        expect(Disclosure.downloadFootprintNote({ provider: 'dictionary' }))
            .toMatch(/dictionary/i);
    });
});
