/** @jest-environment jsdom */
import { MediaPipeKokoroProvider } from '../mediapipe-provider.js';
import { OnnxKokoroProvider } from '../onnx-provider.js';

function mediaProvider() {
    return new MediaPipeKokoroProvider({
        browserApi: { runtime: { getURL: path => 'moz-extension://test/' + path } },
        cacheStorage: { open: jest.fn() },
        fetchImpl: jest.fn(),
    });
}

function onnxProvider() {
    return new OnnxKokoroProvider({
        browserApi: { runtime: { getURL: path => 'moz-extension://test/' + path } },
        cacheStorage: { open: jest.fn() },
        fetchImpl: jest.fn(),
    });
}

describe('local provider teardown retains no stale native resources', () => {
    beforeEach(() => {
        URL.revokeObjectURL = jest.fn();
    });

    test('MediaPipe releases its model Blob URL even if the SDK close rejects', async () => {
        const provider = mediaProvider();
        const failure = new Error('MediaPipe native close failed');
        const engine = { close: jest.fn().mockRejectedValue(failure) };
        provider.engine = engine;
        provider.modelUrl = 'blob:cached-model';
        await expect(provider.close()).rejects.toBe(failure);
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cached-model');
        expect(provider.engine).toBeNull();
        expect(provider.modelUrl).toBeNull();
        await expect(provider.close()).resolves.toBeUndefined();
        expect(engine.close).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    });

    test('MediaPipe cleans up on a normal close and a model URL without an engine', async () => {
        const provider = mediaProvider();
        const engine = { close: jest.fn().mockResolvedValue(undefined) };
        provider.engine = engine;
        provider.modelUrl = 'blob:normal-model';
        await provider.close();
        expect(engine.close).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:normal-model');
        provider.modelUrl = 'blob:orphaned-model';
        await provider.close();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:orphaned-model');
    });

    test('ONNX clears session, voice, engine and lexicon after release failure', async () => {
        const provider = onnxProvider();
        const failure = new Error('ONNX runtime failed to release');
        const session = { release: jest.fn().mockRejectedValue(failure) };
        provider.session = session;
        provider.engine = { env: {} };
        provider.voice = new Uint8Array([1, 2, 3]);
        provider.dictionary = new Map([['hello', 'hɛˈloʊ']]);
        await expect(provider.close()).rejects.toBe(failure);
        expect(provider.session).toBeNull();
        expect(provider.engine).toBeNull();
        expect(provider.voice).toBeNull();
        expect(provider.dictionary).toBeNull();
        await expect(provider.close()).resolves.toBeUndefined();
        expect(session.release).toHaveBeenCalledTimes(1);
    });

    test('ONNX releases a normal session and safely closes an uninitialized instance', async () => {
        const provider = onnxProvider();
        const session = { release: jest.fn().mockResolvedValue(undefined) };
        provider.session = session;
        provider.voice = new Uint8Array([3]);
        await provider.close();
        expect(session.release).toHaveBeenCalledTimes(1);
        expect(provider.session).toBeNull();
        expect(provider.voice).toBeNull();
        await expect(provider.close()).resolves.toBeUndefined();
    });
});
