/** @jest-environment jsdom */
import { AudioManager } from '../audio-manager.js';
import { MediaPipeKokoroProvider } from '../mediapipe-provider.js';

jest.mock('../mediapipe-provider.js', () => ({
    MediaPipeKokoroProvider: jest.fn(),
}));

const pcm = () => ({ samples: new Float32Array([0.2, -0.1, 0.15]), sampleRateHz: 24000 });
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('navigation priority over speculative local synthesis (#57)', () => {
    let manager;
    let provider;
    beforeEach(() => {
        jest.clearAllMocks();
        let urlNumber = 0;
        URL.createObjectURL = jest.fn(() => 'blob:nav-' + (++urlNumber));
        URL.revokeObjectURL = jest.fn();
        provider = {
            synthesize: jest.fn(async () => pcm()),
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
        manager = new AudioManager();
        manager.setSentences(Array.from({ length: 15 }, (_, i) => ({ text: 'Sentence ' + i })));
    });

    test('a distant jump skips two obsolete prefetched sentences instead of synthesizing them', async () => {
        const started = deferred();
        const slow = deferred();
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return slow.promise;
        }).mockResolvedValue(pcm());
        const first = manager.getAudio(0);
        await started.promise;
        manager.prefetch(1);
        manager.prefetch(2);
        await nextTick();

        manager.prioritizeNavigation(9);
        const latest = manager.getAudio(9);
        slow.resolve(pcm());
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(latest).resolves.toBe('blob:nav-1');

        expect(provider.synthesize.mock.calls.map(([text]) => text))
            .toEqual(['Sentence 0', 'Sentence 9']);
        expect(manager.audioCache.has(1)).toBe(false);
        expect(manager.audioCache.has(2)).toBe(false);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('selecting a queued prefetch promotes its sentence to active navigation', async () => {
        const started = deferred();
        const slow = deferred();
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return slow.promise;
        }).mockResolvedValue(pcm());
        const first = manager.getAudio(0);
        await started.promise;
        manager.prefetch(1);
        await nextTick();
        manager.prioritizeNavigation(1);
        const selected = manager.getAudio(1);
        slow.resolve(pcm());
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(selected).resolves.toBe('blob:nav-1');
        expect(provider.synthesize.mock.calls.map(([text]) => text))
            .toEqual(['Sentence 0', 'Sentence 1']);
    });

    test('advancing onto an already executing prefetch reuses it without duplicate synthesis', async () => {
        const started = deferred();
        const finish = deferred();
        const original = await manager.getAudio(0);
        expect(original).toBe('blob:nav-1');
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return finish.promise;
        });
        manager.prefetch(1);
        await started.promise;
        const inFlight = manager.audioCache.get(1);
        expect(inFlight.speculative).toBe(true);
        expect(inFlight.executing).toBe(true);

        manager.prioritizeNavigation(1);
        const selected = manager.getAudio(1);
        // Advancing during real WASM synthesis must preserve the same request.
        expect(manager.audioCache.get(1)).toBe(inFlight);
        expect(provider.synthesize.mock.calls.map(([text]) => text))
            .toEqual(['Sentence 0', 'Sentence 1']);

        finish.resolve(pcm());
        await expect(selected).resolves.toBe('blob:nav-2');
        expect(provider.synthesize.mock.calls.map(([text]) => text))
            .toEqual(['Sentence 0', 'Sentence 1']);
        expect(manager.objectUrls.has('blob:nav-2')).toBe(true);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('an executing prefetch for an abandoned sentence remains discardable', async () => {
        const started = deferred();
        const finish = deferred();
        await manager.getAudio(0);
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return finish.promise;
        }).mockResolvedValue(pcm());

        manager.prefetch(1);
        const abandoned = manager.getAudio(1);
        await started.promise;
        manager.prioritizeNavigation(9);
        const target = manager.getAudio(9);

        finish.resolve(pcm());
        await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
        await expect(target).resolves.toBe('blob:nav-2');
        expect(provider.synthesize.mock.calls.map(([text]) => text))
            .toEqual(['Sentence 0', 'Sentence 1', 'Sentence 9']);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    });

    test('selecting an executing FastAPI prefetch reuses its background request', async () => {
        browser.storage.local.get.mockResolvedValue({
            pendingTtsBackend: 'fastapi',
            pendingApiUrl: 'http://127.0.0.1:8880/v1/',
            pendingVoice: 'af_heart',
        });
        const remoteStarted = deferred();
        const finishRemote = deferred();
        browser.runtime.sendMessage
            .mockResolvedValueOnce({
                success: true, dataUrl: 'data:audio/mpeg;base64,sentence0',
            })
            .mockImplementationOnce(() => {
                remoteStarted.resolve();
                return finishRemote.promise;
            });

        await expect(manager.getAudio(0)).resolves.toBe('data:audio/mpeg;base64,sentence0');
        manager.prefetch(1);
        await remoteStarted.promise;
        const inFlight = manager.audioCache.get(1);
        expect(inFlight.pending).toBe(true);
        expect(inFlight.executing).toBe(true);
        manager.prioritizeNavigation(1);
        const selected = manager.getAudio(1);
        expect(manager.audioCache.get(1)).toBe(inFlight);

        finishRemote.resolve({
            success: true, dataUrl: 'data:audio/mpeg;base64,sentence1',
        });
        await expect(selected).resolves.toBe('data:audio/mpeg;base64,sentence1');
        expect(browser.runtime.sendMessage.mock.calls.map(([request]) => request.payload.input))
            .toEqual(['Sentence 0', 'Sentence 1']);
        expect(provider.synthesize).not.toHaveBeenCalled();
    });

    test('obsolete queued FastAPI prefetch is skipped after a distant jump', async () => {
        browser.storage.local.get.mockResolvedValue({
            pendingTtsBackend: 'fastapi',
            pendingApiUrl: 'http://127.0.0.1:8880/v1/',
            pendingVoice: 'af_heart',
        });
        const started = deferred();
        const finishRemote = deferred();
        browser.runtime.sendMessage.mockImplementationOnce(() => {
            started.resolve();
            return finishRemote.promise;
        }).mockResolvedValue({
            success: true, dataUrl: 'data:audio/mpeg;base64,jump',
        });

        const first = manager.getAudio(0);
        await started.promise;
        manager.prefetch(1);
        manager.prefetch(2);
        await nextTick();
        manager.prioritizeNavigation(9);
        const selected = manager.getAudio(9);
        finishRemote.resolve({
            success: true, dataUrl: 'data:audio/mpeg;base64,obsolete',
        });
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(selected).resolves.toBe('data:audio/mpeg;base64,jump');
        expect(browser.runtime.sendMessage.mock.calls.map(([request]) => request.payload.input))
            .toEqual(['Sentence 0', 'Sentence 9']);
        expect(provider.synthesize).not.toHaveBeenCalled();
    });

    test('pinned exports are not discarded by a navigation jump', async () => {
        const started = deferred();
        const slow = deferred();
        provider.synthesize.mockImplementationOnce(() => {
            started.resolve();
            return slow.promise;
        }).mockResolvedValue(pcm());
        const first = manager.getAudio(0);
        await started.promise;
        const release = manager.pinAudio(1);
        manager.prefetch(1);
        const saved = manager.getAudio(1);
        await nextTick();
        manager.prioritizeNavigation(9);
        const destination = manager.getAudio(9);
        slow.resolve(pcm());

        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(saved).resolves.toBe('blob:nav-1');
        await expect(destination).resolves.toBe('blob:nav-2');
        expect(provider.synthesize.mock.calls.map(([text]) => text))
            .toEqual(['Sentence 0', 'Sentence 1', 'Sentence 9']);
        release();
    });

    test('already-generated current audio stays valid until the replacement is installed', async () => {
        const original = await manager.getAudio(0);
        manager.retainWindow(0);
        manager.prioritizeNavigation(9);
        expect(manager.objectUrls.has(original)).toBe(true);
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(original);

        await manager.getAudio(9);
        manager.retainWindow(9);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(original);
    });
});
