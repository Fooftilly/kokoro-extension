const {
    FASTAPI, MEDIAPIPE, ONNX, KNOWN, resolveBackend, unavailableResponse
} = require('../tts-providers.js');

describe('three-way provider selection (#54)', () => {
    test('preserves FastAPI for missing settings on existing installs', () => {
        expect(resolveBackend()).toBe(FASTAPI);
        expect(resolveBackend(null)).toBe(FASTAPI);
        expect(resolveBackend('')).toBe(FASTAPI);
        expect(KNOWN).toEqual([FASTAPI, MEDIAPIPE, ONNX]);
    });

    test('recognizes each local runtime and fails closed on unknown values', () => {
        expect(resolveBackend('mediapipe')).toBe(MEDIAPIPE);
        expect(resolveBackend('onnx')).toBe(ONNX);
        expect(() => resolveBackend('docker-other')).toThrow(/Unknown Kokoro TTS backend/);
        expect(() => resolveBackend({ name: 'onnx' })).toThrow();
    });

    test('not-yet-implemented local selection reports failure without a remote fallback', () => {
        expect(unavailableResponse(ONNX)).toEqual(expect.objectContaining({
            success: false, kind: 'local-backend-not-installed', backend: ONNX,
        }));
        expect(unavailableResponse(MEDIAPIPE).error).toMatch(/No text was sent to a server/);
        expect(() => unavailableResponse(FASTAPI)).toThrow();
    });
});
