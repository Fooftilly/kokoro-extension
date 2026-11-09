/** @jest-environment jsdom */
jest.mock('../mediapipe-provider.js', () => ({
    MediaPipeKokoroProvider: jest.fn(),
}));
import { AudioManager } from '../audio-manager.js';
import { MediaPipeKokoroProvider } from '../mediapipe-provider.js';

describe('MediaPipe playback cross-tab cache lease', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        global.browser = {
            storage: { local: { get: jest.fn(async () => ({
                pendingTtsBackend: 'mediapipe',
                pendingMediaPipeVariant: 'cpu',
                pendingLocalVoice: 'af_heart',
            })) } },
            runtime: { sendMessage: jest.fn() },
        };
        URL.createObjectURL = jest.fn(() => 'blob:local-audio');
        URL.revokeObjectURL = jest.fn();
    });

    test('shared read lock protects model initialization and synthesis, without FastAPI', async () => {
        let releaseSynthesis;
        let notifySynthesis;
        const synthesisStarted = new Promise(resolve => { notifySynthesis = resolve; });
        const provider = {
            synthesize: jest.fn(() => {
                notifySynthesis();
                return new Promise(resolve => { releaseSynthesis = resolve; });
            }),
            close: jest.fn(),
            cancel: jest.fn(),
        };
        MediaPipeKokoroProvider.mockImplementation(() => provider);
        let leaseActive = false;
        const locks = {
            request: jest.fn(async (name, options, work) => {
                leaseActive = true;
                try { return await work(); } finally { leaseActive = false; }
            }),
        };
        Object.defineProperty(global.navigator, 'locks', {
            configurable: true, value: locks,
        });
        const player = new AudioManager();
        player.setSentences([{ text: 'Private local sentence' }]);
        const audio = player.getAudio(0);
        await synthesisStarted;
        expect(leaseActive).toBe(true);
        expect(locks.request).toHaveBeenCalledWith('kokoro-model-data-v1', {
            mode: 'shared', signal: expect.any(AbortSignal),
        }, expect.any(Function));
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
        releaseSynthesis({
            samples: new Float32Array(2400).fill(0.1), sampleRateHz: 24000,
        });
        await expect(audio).resolves.toBe('blob:local-audio');
        expect(leaseActive).toBe(false);
        expect(MediaPipeKokoroProvider).toHaveBeenCalledWith({ variant: 'cpu' });
    });

    test('cancelling a queued synthesis aborts its requested lock before inference', async () => {
        const provider = {
            synthesize: jest.fn(), close: jest.fn(), cancel: jest.fn(),
        };
        MediaPipeKokoroProvider.mockImplementation(() => provider);
        const locks = {
            request: jest.fn((name, options) => new Promise((resolve, reject) => {
                if (options.signal.aborted) {
                    reject(new DOMException('Aborted', 'AbortError'));
                    return;
                }
                options.signal.addEventListener('abort', () =>
                    reject(new DOMException('Aborted', 'AbortError')), { once: true });
            })),
        };
        Object.defineProperty(global.navigator, 'locks', {
            configurable: true, value: locks,
        });
        const player = new AudioManager();
        player.setSentences([{ text: 'Old sentence' }]);
        const pending = player.getAudio(0);
        // Flush storage read and serialized request dispatch.
        for (let i = 0; i < 20 && !locks.request.mock.calls.length; i++) {
            await Promise.resolve();
        }
        expect(locks.request).toHaveBeenCalledTimes(1);
        player.clear();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(provider.synthesize).not.toHaveBeenCalled();
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });
});
