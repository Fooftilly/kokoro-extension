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
