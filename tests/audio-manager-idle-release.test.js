/** @jest-environment jsdom */
import { installImmediateModelLocks } from './helpers/model-locks.js';
import { AudioManager } from '../audio-manager.js';
import { MediaPipeKokoroProvider } from '../mediapipe-provider.js';
import { OnnxKokoroProvider } from '../onnx-provider.js';

jest.mock('../mediapipe-provider.js', () => ({ MediaPipeKokoroProvider: jest.fn() }));
jest.mock('../onnx-provider.js', () => ({ OnnxKokoroProvider: jest.fn() }));

const IDLE_MS = 5 * 60 * 1000;
const pcm = () => ({ samples: new Float32Array([0.2, -0.1]), sampleRateHz: 24000 });
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
function engine() {
    return {
        synthesize: jest.fn(async () => pcm()),
        cancel: jest.fn(async () => {}),
        close: jest.fn(async () => {}),
    };
}

describe.each(['mediapipe', 'onnx'])('idle %s model release (#56)', backend => {
    let manager;
    let provider;
    let createProvider;
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        provider = engine();
        createProvider = backend === 'mediapipe' ? MediaPipeKokoroProvider : OnnxKokoroProvider;
        createProvider.mockImplementation(() => provider);
        URL.createObjectURL = jest.fn(() => 'blob:cached-audio');
        URL.revokeObjectURL = jest.fn();
        global.browser = {
            storage: { local: { get: jest.fn(async () => ({ pendingTtsBackend: backend })) } },
            runtime: { sendMessage: jest.fn() },
        };
        installImmediateModelLocks();
        manager = new AudioManager();
        manager.setSentences([{ text: 'First sentence.' }, { text: 'Second sentence.' }]);
    });
    afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

    test('releases the idle engine once while preserving playable/exportable audio', async () => {
        const release = manager.pinAudio(0);
        const audio = await manager.getAudio(0);
        await jest.advanceTimersByTimeAsync(IDLE_MS - 1);
        expect(provider.close).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(provider.close).toHaveBeenCalledTimes(1);
        expect(manager.localProvider).toBeNull();
        expect(manager.localBackend).toBeNull();
        expect(manager.localVariant).toBeNull();
        expect(await manager.getAudio(0)).toBe(audio);
        expect(provider.synthesize).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        expect(manager.objectUrls.has(audio)).toBe(true);
        await jest.advanceTimersByTimeAsync(IDLE_MS);
        expect(provider.close).toHaveBeenCalledTimes(1);
        release();
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('keeps a consecutive reading session warm and resets the idle deadline', async () => {
        await manager.getAudio(0);
        await jest.advanceTimersByTimeAsync(IDLE_MS - 1);
        await manager.getAudio(1);
        expect(createProvider).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(IDLE_MS - 1);
        expect(provider.close).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(provider.close).toHaveBeenCalledTimes(1);
    });

    test('does not unload an engine while slow inference or queued work is running', async () => {
        const started = deferred();
        const finish = deferred();
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return finish.promise;
        });
        const first = manager.getAudio(0);
        await started.promise;
        const second = manager.getAudio(1);
        await jest.advanceTimersByTimeAsync(IDLE_MS * 2);
        expect(provider.close).not.toHaveBeenCalled();
        expect(provider.synthesize).toHaveBeenCalledTimes(1);
        finish.resolve(pcm());
        await Promise.all([first, second]);
        await jest.advanceTimersByTimeAsync(IDLE_MS);
        expect(provider.close).toHaveBeenCalledTimes(1);
    });

    test('a session reset joins cancellation before starting the idle countdown', async () => {
        await manager.getAudio(0);
        const finishCancel = deferred();
        provider.cancel.mockImplementationOnce(() => finishCancel.promise);
        manager.clear();
        await jest.advanceTimersByTimeAsync(IDLE_MS * 2);
        expect(provider.close).not.toHaveBeenCalled();
        finishCancel.resolve();
        await jest.advanceTimersByTimeAsync(IDLE_MS - 1);
        expect(provider.close).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(provider.close).toHaveBeenCalledTimes(1);
    });

    test('new synthesis waits for an idle teardown already in progress', async () => {
        await manager.getAudio(0);
        const finishClose = deferred();
        provider.close.mockImplementationOnce(() => finishClose.promise);
        await jest.advanceTimersByTimeAsync(IDLE_MS);
        expect(provider.close).toHaveBeenCalledTimes(1);
        const nextProvider = engine();
        createProvider.mockImplementation(() => nextProvider);
        const next = manager.getAudio(1);
        await jest.advanceTimersByTimeAsync(0);
        expect(nextProvider.synthesize).not.toHaveBeenCalled();
        finishClose.resolve();
        await next;
        expect(createProvider).toHaveBeenCalledTimes(2);
        expect(nextProvider.synthesize).toHaveBeenCalledWith('Second sentence.', expect.any(Object));
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('an inference failure still permits idle cleanup and a subsequent retry', async () => {
        provider.synthesize.mockRejectedValueOnce(new Error('WASM inference failed'));
        const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(manager.getAudio(0)).rejects.toThrow('WASM inference failed');
            await jest.advanceTimersByTimeAsync(IDLE_MS);
            expect(provider.close).toHaveBeenCalledTimes(1);
            const fresh = engine();
            createProvider.mockImplementation(() => fresh);
            await expect(manager.getAudio(0)).resolves.toBe('blob:cached-audio');
            expect(fresh.synthesize).toHaveBeenCalledTimes(1);
        } finally { logging.mockRestore(); }
    });

    test('a failed native close cannot poison later inference or cause remote fallback', async () => {
        await manager.getAudio(0);
        const failure = new Error('Native release failed');
        provider.close.mockRejectedValueOnce(failure);
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await jest.advanceTimersByTimeAsync(IDLE_MS);
            expect(warning).toHaveBeenCalledWith('Local TTS idle release failed', failure);
            const fresh = engine();
            createProvider.mockImplementation(() => fresh);
            await manager.getAudio(1);
            expect(fresh.synthesize).toHaveBeenCalledTimes(1);
            expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
        } finally { warning.mockRestore(); }
    });
});

test('FastAPI playback never schedules a local model teardown', async () => {
    jest.useFakeTimers();
    try {
        global.browser = {
            storage: { local: { get: jest.fn(async () => ({
                pendingTtsBackend: 'fastapi', pendingApiUrl: 'http://localhost:8880/v1/',
            })) } },
            runtime: { sendMessage: jest.fn(async () => ({ success: true, dataUrl: 'data:audio/mpeg;base64,test' })) },
        };
        const manager = new AudioManager();
        manager.setSentences([{ text: 'Hello.' }]);
        await manager.getAudio(0);
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});

test('rejects idle intervals that would overflow or immediately fire a browser timer', () => {
    for (const localProviderIdleMs of [0, -1, NaN, Infinity, '100', 2147483648]) {
        expect(() => new AudioManager({ localProviderIdleMs })).toThrow(RangeError);
    }
});
