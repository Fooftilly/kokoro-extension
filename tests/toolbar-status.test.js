/**
 * Pure toolbar status helpers (#208).
 */

const ToolbarStatus = require('../toolbar-status.js');

describe('toolbar-status helpers (#208)', () => {
    test('ready uses green icons; unreachable uses red; setup/unknown use defaults', () => {
        expect(ToolbarStatus.iconPathsForKind(ToolbarStatus.KIND.READY)[48])
            .toMatch(/icon-48-green/);
        expect(ToolbarStatus.iconPathsForKind(ToolbarStatus.KIND.UNREACHABLE)[48])
            .toMatch(/icon-48-red/);
        expect(ToolbarStatus.iconPathsForKind(ToolbarStatus.KIND.NEEDS_SETUP)[48])
            .toBe('icons/icon48.png');
        expect(ToolbarStatus.iconPathsForKind(ToolbarStatus.KIND.UNKNOWN)[128])
            .toBe('icons/icon128.png');
    });

    test('titles distinguish FastAPI reachability from local readiness', () => {
        expect(ToolbarStatus.titleForStatus({
            kind: ToolbarStatus.KIND.READY, backend: 'fastapi',
        })).toMatch(/server reachable/i);
        expect(ToolbarStatus.titleForStatus({
            kind: ToolbarStatus.KIND.UNREACHABLE, backend: 'fastapi',
        })).toMatch(/unreachable/i);
        expect(ToolbarStatus.titleForStatus({
            kind: ToolbarStatus.KIND.READY, backend: 'mediapipe',
        })).toMatch(/MediaPipe ready \(on-device\)/);
        expect(ToolbarStatus.titleForStatus({
            kind: ToolbarStatus.KIND.NEEDS_SETUP,
            backend: 'onnx',
            detail: 'model not installed',
        })).toMatch(/Test TTS backends/i);
        expect(ToolbarStatus.titleForStatus({
            kind: ToolbarStatus.KIND.UNKNOWN,
        })).toMatch(/unknown/i);
    });

    test('classifyLocalReadiness never marks ready without validation + install', () => {
        expect(ToolbarStatus.classifyLocalReadiness({
            backend: 'mediapipe',
            expectedRevision: 'abc',
            validatedRevision: null,
            modelReady: true,
        }).kind).toBe(ToolbarStatus.KIND.NEEDS_SETUP);

        expect(ToolbarStatus.classifyLocalReadiness({
            backend: 'mediapipe',
            expectedRevision: 'abc',
            validatedRevision: 'abc',
            modelReady: false,
        }).kind).toBe(ToolbarStatus.KIND.NEEDS_SETUP);

        expect(ToolbarStatus.classifyLocalReadiness({
            backend: 'mediapipe',
            expectedRevision: 'abc',
            validatedRevision: 'abc',
            modelReady: true,
        }).kind).toBe(ToolbarStatus.KIND.READY);

        expect(ToolbarStatus.classifyLocalReadiness({
            backend: 'onnx',
            expectedRevision: 'abc',
            validatedRevision: 'abc',
            modelReady: true,
            dictionaryReady: false,
        }).detail).toMatch(/dictionary/i);

        expect(ToolbarStatus.classifyLocalReadiness({
            backend: 'onnx',
            expectedRevision: 'abc',
            validatedRevision: 'abc',
            modelReady: true,
            dictionaryReady: true,
            optionalVoiceRequired: true,
            voiceReady: false,
        }).kind).toBe(ToolbarStatus.KIND.NEEDS_SETUP);

        expect(ToolbarStatus.classifyLocalReadiness({
            backend: 'mediapipe',
            expectedRevision: 'abc',
            validatedRevision: 'abc',
            modelReady: undefined,
        }).kind).toBe(ToolbarStatus.KIND.UNKNOWN);
    });

    test('validated-revision storage keys are detected for refresh', () => {
        expect(ToolbarStatus.isValidatedRevisionStorageKey('mediapipeValidatedRevision:cpu'))
            .toBe(true);
        expect(ToolbarStatus.isValidatedRevisionStorageKey('onnxValidatedRevision:q8'))
            .toBe(true);
        expect(ToolbarStatus.isValidatedRevisionStorageKey('theme')).toBe(false);
    });
});
