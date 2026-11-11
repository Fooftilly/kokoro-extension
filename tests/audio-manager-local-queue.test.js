/** @jest-environment jsdom */
import { installImmediateModelLocks } from './helpers/model-locks.js';
import { AudioManager } from '../audio-manager.js';
import { MediaPipeKokoroProvider } from '../mediapipe-provider.js';
import { OnnxKokoroProvider } from '../onnx-provider.js';

jest.mock('../mediapipe-provider.js', () => ({
    MediaPipeKokoroProvider: jest.fn(),
}));
jest.mock('../onnx-provider.js', () => ({ OnnxKokoroProvider: jest.fn() }));

const pcm = () => ({ samples: new Float32Array([0.2, -0.15, 0.1]), sampleRateHz: 24000 });
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('local Kokoro synthesis is serialized across reading-session resets (#57)', () => {
    let manager;
    let provider;
    beforeEach(() => {
        jest.clearAllMocks();
        provider = {
            synthesize: jest.fn(),
            cancel: jest.fn(async () => {}),
            close: jest.fn(async () => {}),
        };
        MediaPipeKokoroProvider.mockImplementation(() => provider);
        global.browser = {
            storage: { local: { get: jest.fn(async () => ({
                pendingTtsBackend: 'mediapipe',
                pendingMediaPipeVariant: 'cpu',
                pendingLocalVoice: 'af_heart',
            })) } },
            runtime: { sendMessage: jest.fn() },
        };
        URL.createObjectURL = jest.fn()
            .mockReturnValueOnce('blob:next').mockReturnValue('blob:latest');
        URL.revokeObjectURL = jest.fn();
        installImmediateModelLocks();
        manager = new AudioManager();
    });

    test('new session waits for in-progress WASM synthesis; stale audio is rejected', async () => {
        const firstAudio = deferred();
        const started = deferred();
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return firstAudio.promise;
        }).mockResolvedValueOnce(pcm());

        manager.setSentences([{ text: 'old private sentence' }]);
        const first = manager.getAudio(0);
        await started.promise;
        manager.clear();
        manager.setSentences([{ text: 'new private sentence' }]);
        const second = manager.getAudio(0);

        await nextTick();
        expect(provider.synthesize).toHaveBeenCalledTimes(1);
        expect(provider.cancel).toHaveBeenCalledTimes(1);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();

        firstAudio.resolve(pcm());
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(second).resolves.toBe('blob:next');
        expect(provider.synthesize.mock.calls.map(call => call[0])).toEqual([
            'old private sentence', 'new private sentence',
        ]);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('does not launch the next session while cancellation is still pending', async () => {
        const firstAudio = deferred();
        const started = deferred();
        const finishCancellation = deferred();
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return firstAudio.promise;
        }).mockResolvedValueOnce(pcm());
        provider.cancel.mockImplementationOnce(() => finishCancellation.promise);

        manager.setSentences([{ text: 'old sentence' }]);
        const first = manager.getAudio(0);
        await started.promise;
        manager.clear();
        manager.setSentences([{ text: 'new sentence' }]);
        const second = manager.getAudio(0);

        // The prior WASM call is no longer running, but its cancellation is
        // not finished: the next synthesis must still remain blocked.
        firstAudio.resolve(pcm());
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await nextTick();
        expect(provider.cancel).toHaveBeenCalledTimes(1);
        expect(provider.synthesize).toHaveBeenCalledTimes(1);
        expect(URL.createObjectURL).not.toHaveBeenCalled();

        finishCancellation.resolve();
        await expect(second).resolves.toBe('blob:next');
        expect(provider.synthesize.mock.calls.map(call => call[0])).toEqual([
            'old sentence', 'new sentence',
        ]);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('failed cancellation is logged and cannot poison the local queue', async () => {
        const firstAudio = deferred();
        const started = deferred();
        const finishCancellation = deferred();
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return firstAudio.promise;
        }).mockResolvedValueOnce(pcm());
        provider.cancel.mockImplementationOnce(() => finishCancellation.promise);
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            manager.setSentences([{ text: 'old request' }]);
            const first = manager.getAudio(0);
            await started.promise;
            manager.clear();
            manager.setSentences([{ text: 'fresh request' }]);
            const second = manager.getAudio(0);

            firstAudio.resolve(pcm());
            await expect(first).rejects.toMatchObject({ name: 'AbortError' });
            await nextTick();
            expect(provider.synthesize).toHaveBeenCalledTimes(1);
            finishCancellation.reject(new Error('SDK cancel failed'));
            await expect(second).resolves.toBe('blob:next');
            expect(warning).toHaveBeenCalledWith(
                'Local TTS cancellation failed', expect.any(Error));
            expect(provider.synthesize).toHaveBeenCalledTimes(2);
        } finally {
            warning.mockRestore();
        }
    });

    test('queued request from another cleared generation never reaches WASM', async () => {
        const firstAudio = deferred();
        const started = deferred();
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return firstAudio.promise;
        }).mockResolvedValueOnce(pcm());

        manager.setSentences([{ text: 'session one' }]);
        const first = manager.getAudio(0);
        await started.promise;
        manager.clear();
        manager.setSentences([{ text: 'session two' }]);
        const second = manager.getAudio(0);
        await nextTick();
        manager.clear();
        manager.setSentences([{ text: 'session three' }]);
        const third = manager.getAudio(0);

        firstAudio.resolve(pcm());
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(second).rejects.toMatchObject({ name: 'AbortError' });
        await expect(third).resolves.toBe('blob:next');
        expect(provider.synthesize.mock.calls.map(call => call[0])).toEqual([
            'session one', 'session three',
        ]);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    });

    test('switching from ONNX to MediaPipe waits for old WASM work and releases ONNX', async () => {
        const onnxStarted = deferred();
        const onnxFinished = deferred();
        const releaseOld = deferred();
        const onnx = {
            synthesize: jest.fn(() => { onnxStarted.resolve(); return onnxFinished.promise; }),
            cancel: jest.fn(async () => {}), // ONNX cannot interrupt an active run.
            close: jest.fn(() => releaseOld.promise),
        };
        OnnxKokoroProvider.mockImplementation(() => onnx);
        provider.synthesize.mockResolvedValue(pcm());
        browser.storage.local.get
            .mockResolvedValueOnce({ pendingTtsBackend: 'onnx' })
            .mockResolvedValueOnce({ pendingTtsBackend: 'mediapipe', pendingMediaPipeVariant: 'cpu' });
        manager.setSentences([{ text: 'First ONNX sentence' }]);
        const old = manager.getAudio(0);
        await onnxStarted.promise;
        manager.clear();
        manager.setSentences([{ text: 'New MediaPipe sentence' }]);
        const newer = manager.getAudio(0);
        await nextTick();
        expect(onnx.cancel).toHaveBeenCalledTimes(1);
        expect(provider.synthesize).not.toHaveBeenCalled();
        expect(onnx.close).not.toHaveBeenCalled();

        onnxFinished.resolve(pcm());
        await expect(old).rejects.toMatchObject({ name: 'AbortError' });
        await nextTick();
        expect(onnx.close).toHaveBeenCalledTimes(1);
        expect(provider.synthesize).not.toHaveBeenCalled();

        releaseOld.resolve();
        await expect(newer).resolves.toBe('blob:next');
        expect(OnnxKokoroProvider).toHaveBeenCalledWith({ variant: 'q8' });
        expect(MediaPipeKokoroProvider).toHaveBeenCalledWith({ variant: 'cpu' });
        expect(provider.synthesize).toHaveBeenCalledWith('New MediaPipe sentence',
            { voiceId: 'af_heart' });
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('ONNX provider remains warm for consecutive sentences without remote calls', async () => {
        const onnx = {
            synthesize: jest.fn().mockImplementation(async () => pcm()),
            cancel: jest.fn(async () => {}),
            close: jest.fn(async () => {}),
        };
        OnnxKokoroProvider.mockImplementation(() => onnx);
        browser.storage.local.get.mockResolvedValue({ pendingTtsBackend: 'onnx' });
        manager.setSentences([{ text: 'Hello world.' }, { text: 'Good morning.' }]);
        await manager.getAudio(0);
        await manager.getAudio(1);
        expect(OnnxKokoroProvider).toHaveBeenCalledTimes(1);
        expect(onnx.synthesize.mock.calls).toEqual([
            ['Hello world.', { speed: 1 }],
            ['Good morning.', { speed: 1 }],
        ]);
        expect(onnx.close).not.toHaveBeenCalled();
        expect(MediaPipeKokoroProvider).not.toHaveBeenCalled();
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('a prior failed local inference does not poison later generation', async () => {
        const failed = deferred();
        const started = deferred();
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return failed.promise;
        }).mockResolvedValueOnce(pcm());
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            manager.setSentences([{ text: 'failed request' }]);
            const first = manager.getAudio(0);
            await started.promise;
            manager.clear();
            manager.setSentences([{ text: 'retry' }]);
            const second = manager.getAudio(0);
            failed.reject(new Error('WASM provider aborted'));
            await expect(first).rejects.toMatchObject({ name: 'AbortError' });
            await expect(second).resolves.toBe('blob:next');
            expect(provider.synthesize).toHaveBeenCalledTimes(2);
            expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });
});
