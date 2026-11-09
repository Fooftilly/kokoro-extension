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

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
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

    test('MediaPipe close waits for unfinished engine construction before revoking its Blob URL', async () => {
        const provider = mediaProvider();
        const ready = deferred();
        const engine = { close: jest.fn(async () => {}) };
        const loader = jest.spyOn(provider, 'loadEngine').mockImplementation(async () => {
            await ready.promise;
            provider.engine = engine;
            provider.modelUrl = 'blob:slow-media';
        });
        const initializing = provider.initialize();
        const firstClose = provider.close();
        const secondClose = provider.close();
        expect(engine.close).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        ready.resolve();
        await initializing;
        await Promise.all([firstClose, secondClose]);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(engine.close).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:slow-media');
        expect(provider.engine).toBeNull();
        expect(provider.modelUrl).toBeNull();
    });

    test('MediaPipe initialization cannot replace the engine until native close finishes', async () => {
        const provider = mediaProvider();
        const release = deferred();
        const oldEngine = { close: jest.fn(() => release.promise) };
        const newEngine = { close: jest.fn(async () => {}) };
        provider.engine = oldEngine;
        provider.modelUrl = 'blob:old-media';
        const nextLoad = jest.spyOn(provider, 'loadEngine').mockImplementation(async () => {
            provider.engine = newEngine;
            provider.modelUrl = 'blob:new-media';
        });
        const closing = provider.close();
        const starting = provider.initialize();
        await Promise.resolve();
        expect(nextLoad).not.toHaveBeenCalled();
        release.resolve();
        await closing;
        await starting;
        expect(oldEngine.close).toHaveBeenCalledTimes(1);
        expect(nextLoad).toHaveBeenCalledTimes(1);
        expect(provider.engine).toBe(newEngine);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-media');
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:new-media');
        await provider.close();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:new-media');
    });

    test('ONNX close joins a pending session and clears the late-created voice data', async () => {
        const provider = onnxProvider();
        const ready = deferred();
        const session = { release: jest.fn(async () => {}) };
        jest.spyOn(provider, 'loadEngine').mockImplementation(async () => {
            await ready.promise;
            provider.session = session;
            provider.engine = { env: {} };
            provider.voice = new Uint8Array([1, 2, 3]);
        });
        const initializing = provider.initialize();
        const closing = provider.close();
        expect(session.release).not.toHaveBeenCalled();
        ready.resolve();
        await initializing;
        await closing;
        expect(session.release).toHaveBeenCalledTimes(1);
        expect(provider.session).toBeNull();
        expect(provider.voice).toBeNull();
        expect(provider.engine).toBeNull();
    });

    test('ONNX waits for lexicon parsing to settle before clearing cached dictionary', async () => {
        const provider = onnxProvider();
        const ready = deferred();
        provider.loadDictionary = jest.fn(() => ready.promise);
        const lexicon = provider.englishLexicon();
        const closing = provider.close();
        ready.resolve(new Map([['hello', 'hɛˈloʊ']]));
        await lexicon;
        await closing;
        expect(provider.dictionary).toBeNull();
        expect(provider.dictionaryLoading).toBeNull();
        await provider.englishLexicon();
        expect(provider.dictionary).toBeInstanceOf(Map);
        expect(provider.loadDictionary).toHaveBeenCalledTimes(2);
    });

    test('failed initialization does not prevent close or a later clean retry', async () => {
        const provider = mediaProvider();
        const ready = deferred();
        const error = new Error('SDK construction failed');
        const engine = { close: jest.fn(async () => {}) };
        const loader = jest.spyOn(provider, 'loadEngine')
            .mockImplementationOnce(async () => {
                await ready.promise;
                throw error;
            })
            .mockImplementationOnce(async () => {
                provider.engine = engine;
                provider.modelUrl = 'blob:retried-media';
            });
        const initializing = provider.initialize();
        const rejected = expect(initializing).rejects.toBe(error);
        const closing = provider.close();
        ready.resolve();
        await rejected;
        await closing;
        expect(provider.engine).toBeNull();
        await provider.initialize();
        expect(loader).toHaveBeenCalledTimes(2);
        expect(provider.engine).toBe(engine);
        await provider.close();
        expect(engine.close).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:retried-media');
    });
});
