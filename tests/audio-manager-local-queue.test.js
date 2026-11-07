/** @jest-environment jsdom */
import { AudioManager } from '../audio-manager.js';
import { MediaPipeKokoroProvider } from '../mediapipe-provider.js';

jest.mock('../mediapipe-provider.js', () => ({
    MediaPipeKokoroProvider: jest.fn(),
}));

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
