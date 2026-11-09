const {
    FASTAPI, MEDIAPIPE, ONNX, KNOWN, resolveBackend, unavailableResponse,
    getCapabilities, listCapabilities, resolvePlaybackConnection
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

    test('playback connections retain server URLs only for FastAPI', () => {
        const privateUrl = 'http://private-lan.example:8880/v1';
        expect(resolvePlaybackConnection(undefined, privateUrl)).toEqual({
            backend: FASTAPI, apiUrl: privateUrl + '/',
        });
        expect(resolvePlaybackConnection(FASTAPI, '  ' + privateUrl + '  ')).toEqual({
            backend: FASTAPI, apiUrl: privateUrl + '/',
        });
        for (const backend of [MEDIAPIPE, ONNX]) {
            expect(resolvePlaybackConnection(backend, privateUrl)).toEqual({
                backend, apiUrl: null,
            });
            expect(resolvePlaybackConnection(backend, null)).toEqual({
                backend, apiUrl: null,
            });
        }
        expect(() => resolvePlaybackConnection(FASTAPI, null)).toThrow(/Configure a Kokoro server URL/);
        expect(() => resolvePlaybackConnection('invalid', privateUrl)).toThrow(/Unknown Kokoro TTS backend/);
    });

    test('capability descriptors cover exactly three explicit engines without claiming readiness', () => {
        const entries = listCapabilities();
        expect(entries.map(item => item.id)).toEqual([FASTAPI, MEDIAPIPE, ONNX]);
        expect(entries.every(item => item.readiness !== 'ready')).toBe(true);
        expect(entries[0]).toEqual(expect.objectContaining({
            execution: 'server',
            installation: 'external',
            textSynthesis: 'supported',
            weightedVoiceMixing: true,
            availableVoices: 'query-server',
        }));
        expect(entries[1]).toEqual(expect.objectContaining({
            execution: 'on-device',
            modelStatus: 'not-checked',
            readiness: 'requires-runtime-check',
            textSynthesis: 'experimental',
            weightedVoiceMixing: false,
        }));
        expect(entries[2]).toEqual(expect.objectContaining({
            execution: 'on-device',
            modelStatus: 'not-checked',
            textSynthesis: 'experimental',
            phonemeSynthesis: 'diagnostic-only',
            weightedVoiceMixing: false,
        }));
        expect(getCapabilities()).toBe(getCapabilities(FASTAPI));
        expect(getCapabilities(ONNX).outputFormats).toEqual(['wav']);
        expect(() => getCapabilities('unknown')).toThrow(/Unknown Kokoro TTS backend/);
    });

    test('capability metadata is immutable in shared worker and test-page contexts', () => {
        const fastapi = getCapabilities(FASTAPI);
        const mediapipe = getCapabilities(MEDIAPIPE);
        expect(Object.isFrozen(fastapi)).toBe(true);
        expect(Object.isFrozen(mediapipe.outputFormats)).toBe(true);
        expect(Object.isFrozen(listCapabilities())).toBe(false);
        expect(mediapipe.outputFormats).toEqual(['wav']);
    });

    test('not-yet-implemented local selection reports failure without a remote fallback', () => {
        expect(unavailableResponse(ONNX)).toEqual(expect.objectContaining({
            success: false, kind: 'local-backend-not-installed', backend: ONNX,
        }));
        expect(unavailableResponse(MEDIAPIPE).error).toMatch(/No text was sent to a server/);
        expect(() => unavailableResponse(FASTAPI)).toThrow();
    });
});
