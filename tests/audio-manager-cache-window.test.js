/** @jest-environment jsdom */
import { installImmediateModelLocks } from './helpers/model-locks.js';
import { AudioManager } from '../audio-manager.js';
import { MediaPipeKokoroProvider } from '../mediapipe-provider.js';

jest.mock('../mediapipe-provider.js', () => ({
    MediaPipeKokoroProvider: jest.fn(),
}));

const pcm = () => ({ samples: new Float32Array([0.3, -0.2, 0.1]), sampleRateHz: 24000 });
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

describe('bounded playback sentence cache and download leases (#57)', () => {
    let manager;
    let provider;
    let nextUrl;
    beforeEach(() => {
        jest.clearAllMocks();
        nextUrl = 0;
        URL.createObjectURL = jest.fn(() => 'blob:kokoro-' + (++nextUrl));
        URL.revokeObjectURL = jest.fn();
        provider = {
            synthesize: jest.fn().mockImplementation(async () => pcm()),
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
        installImmediateModelLocks();
        manager = new AudioManager();
        manager.setSentences(Array.from({ length: 30 }, (_, i) => ({
            text: 'Sentence ' + i,
        })));
    });

    test('a long reading session keeps only a small recent window of local blob URLs', async () => {
        const urls = [];
        for (let i = 0; i < 22; i++) {
            urls.push(await manager.getAudio(i));
            manager.retainWindow(i);
            expect(manager.audioCache.size).toBeLessThanOrEqual(3);
            expect(manager.objectUrls.size).toBeLessThanOrEqual(3);
        }
        expect(provider.synthesize).toHaveBeenCalledTimes(22);
        expect(manager.objectUrls.has(urls[21])).toBe(true);
        expect(manager.objectUrls.has(urls[19])).toBe(true);
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(19);
        const previouslyCached = await manager.getAudio(20);
        expect(previouslyCached).toBe(urls[20]);
        expect(provider.synthesize).toHaveBeenCalledTimes(22);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('a requested sentence outside the window is regenerated after eviction', async () => {
        const original = await manager.getAudio(0);
        manager.retainWindow(0);
        await manager.getAudio(8);
        manager.retainWindow(8);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(original);
        const fresh = await manager.getAudio(0);
        expect(fresh).not.toBe(original);
        expect(provider.synthesize).toHaveBeenCalledTimes(3);
    });

    test('a pinned download survives window eviction and a session reset', async () => {
        const release = manager.pinAudio(0);
        const url = await manager.getAudio(0);
        manager.retainWindow(15);
        expect(manager.audioCache.has(0)).toBe(true);
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
        manager.clear();
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
        release();
        release(); // a download completion listener may fire more than once
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
        expect(manager.objectUrls.has(url)).toBe(false);
    });

    test('releasing an old pin cannot revoke a newer session URL at the same index', async () => {
        const releaseOld = manager.pinAudio(0);
        const oldUrl = await manager.getAudio(0);
        manager.clear();
        manager.setSentences([{ text: 'New document' }]);
        const newUrl = await manager.getAudio(0);
        manager.retainWindow(0);
        releaseOld();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldUrl);
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(newUrl);
        expect(manager.objectUrls.has(newUrl)).toBe(true);
    });

    test('evicting queued local inference prevents wasted synthesis', async () => {
        const started = deferred();
        const pending = deferred();
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return pending.promise;
        });
        const first = manager.getAudio(0);
        await started.promise;
        const second = manager.getAudio(1);
        manager.retainWindow(10);
        pending.resolve(pcm());
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(second).rejects.toMatchObject({ name: 'AbortError' });
        expect(provider.synthesize).toHaveBeenCalledTimes(1);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });
});
