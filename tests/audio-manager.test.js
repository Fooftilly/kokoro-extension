/**
 * @jest-environment jsdom
 */

import { AudioManager } from '../audio-manager.js';

// Mock browser API
global.browser = {
    storage: {
        local: {
            get: jest.fn()
        }
    },
    runtime: {
        sendMessage: jest.fn()
    }
};

describe('AudioManager', () => {
    let audioManager;

    beforeEach(() => {
        // Ensure mock is clean and has default behavior if needed
        jest.clearAllMocks();

        // Setup default mocks behavior
        browser.storage.local.get.mockImplementation(async () => {
            return {
                pendingVoice: 'af_heart',
                pendingApiUrl: 'http://localhost:8880',
                pendingNormalizationOptions: {}
            };
        });

        audioManager = new AudioManager();
    });

    test('local selection never dispatches to remote audio fetch', async () => {
        browser.storage.local.get.mockResolvedValue({
            pendingTtsBackend: 'onnx', pendingVoice: 'af_heart',
            pendingApiUrl: 'http://localhost:8880',
        });
        audioManager.setSentences([{ text: 'Private text' }]);
        await expect(audioManager.getAudio(0)).rejects.toThrow(/Local TTS backend/);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('clear rejects a request whose settings were still loading without dispatching it', async () => {
        let releaseSettings;
        browser.storage.local.get.mockImplementation(() => new Promise(resolve => {
            releaseSettings = resolve;
        }));
        audioManager.setSentences([{ text: 'Old private text' }]);
        const previous = audioManager.getAudio(0);
        audioManager.clear();
        releaseSettings({
            pendingTtsBackend: 'fastapi', pendingApiUrl: 'http://localhost:8880',
        });
        await expect(previous).rejects.toMatchObject({ name: 'AbortError' });
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('clear cancels both in-flight remote results and older queued requests', async () => {
        let notifyStarted;
        const started = new Promise(resolve => { notifyStarted = resolve; });
        let finishRemote;
        browser.runtime.sendMessage.mockImplementationOnce(() => {
            notifyStarted();
            return new Promise(resolve => { finishRemote = resolve; });
        });
        audioManager.setSentences([{ text: 'First' }, { text: 'Second' }]);
        const first = audioManager.getAudio(0);
        const second = audioManager.getAudio(1);
        await started;
        audioManager.clear();
        finishRemote({ success: true, dataUrl: 'data:audio/mpeg;base64,stale' });
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(second).rejects.toMatchObject({ name: 'AbortError' });
        expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);

        browser.runtime.sendMessage.mockResolvedValueOnce({
            success: true, dataUrl: 'data:audio/mpeg;base64,new',
        });
        audioManager.setSentences([{ text: 'New' }]);
        await expect(audioManager.getAudio(0)).resolves.toBe('data:audio/mpeg;base64,new');
        expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(2);
    });

    test('a failed sentence request is retried rather than permanently cached', async () => {
        const logger = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            browser.runtime.sendMessage
                .mockResolvedValueOnce({ success: false, error: 'Temporary TTS error' })
                .mockResolvedValueOnce({ success: true, dataUrl: 'data:audio/mpeg;base64,retry' });
            audioManager.setSentences([{ text: 'Retry me' }]);
            await expect(audioManager.getAudio(0)).rejects.toThrow('Temporary TTS error');
            await expect(audioManager.getAudio(0)).resolves.toBe('data:audio/mpeg;base64,retry');
            expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(2);
        } finally {
            logger.mockRestore();
        }
    });

    test('should fetch audio via background and cache it', async () => {
        // Mock background fetch success
        browser.runtime.sendMessage.mockResolvedValue({
            success: true,
            dataUrl: 'data:audio/mpeg;base64,mockdata'
        });

        audioManager.setSentences([{ text: 'Hello world' }]);

        // Call getAudio
        const urlPromise = audioManager.getAudio(0);
        const url = await urlPromise;

        expect(url).toBe('data:audio/mpeg;base64,mockdata');
        expect(browser.storage.local.get).toHaveBeenCalled();
        expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'FETCH_TTS_AUDIO',
                endpoint: expect.stringContaining('http://localhost:8880'),
                payload: expect.objectContaining({
                    input: 'Hello world'
                })
            })
        );
    });

    test('should return cached promise result if called twice', async () => {
        browser.runtime.sendMessage.mockResolvedValue({
            success: true,
            dataUrl: 'data:audio/mpeg;base64,mockdata'
        });

        audioManager.setSentences([{ text: 'Test' }]);

        const p1 = audioManager.getAudio(0);
        const p2 = audioManager.getAudio(0);

        await Promise.all([p1, p2]);

        expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    test('should handle background fetch errors', async () => {
        browser.runtime.sendMessage.mockResolvedValue({
            success: false,
            error: 'API Error: 500 Internal Server Error'
        });

        // Suppress console.error for this test
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        audioManager.setSentences([{ text: 'Error' }]);

        await expect(audioManager.getAudio(0)).rejects.toThrow('API Error: 500 Internal Server Error');

        consoleSpy.mockRestore();
    });
});
