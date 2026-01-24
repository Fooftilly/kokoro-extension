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
    }
};

// Mock fetch
global.fetch = jest.fn();

// Mock URL.createObjectURL
global.URL.createObjectURL = jest.fn((blob) => 'blob:mock-url');

describe('AudioManager', () => {
    let audioManager;

    beforeEach(() => {
        // Ensure mock is clean and has default behavior if needed
        jest.clearAllMocks();

        // Setup default mocks behavior
        browser.storage.local.get.mockImplementation(async () => {
            return {
                pendingVoice: 'af_heart',
                pendingApiUrl: 'http://localhost:8880'
            };
        });

        audioManager = new AudioManager();
    });

    test('should fetch audio and cache it', async () => {
        // Mock fetch success
        global.fetch.mockResolvedValue({
            ok: true,
            blob: jest.fn().mockResolvedValue(new Blob(['audio'], { type: 'audio/mpeg' }))
        });

        audioManager.setSentences([{ text: 'Hello world' }]);

        // Call getAudio
        const urlPromise = audioManager.getAudio(0);
        const url = await urlPromise;

        expect(url).toBe('blob:mock-url');
        expect(browser.storage.local.get).toHaveBeenCalled();
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('http://localhost:8880'),
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('Hello world')
            })
        );
    });

    test('should return cached promise result if called twice', async () => {
        browser.storage.local.get.mockResolvedValue({
            pendingVoice: 'af_heart',
            pendingApiUrl: 'http://localhost:8880'
        });
        global.fetch.mockResolvedValue({
            ok: true,
            blob: jest.fn().mockResolvedValue(new Blob())
        });

        audioManager.setSentences([{ text: 'Test' }]);

        const p1 = audioManager.getAudio(0);
        const p2 = audioManager.getAudio(0);

        await Promise.all([p1, p2]);

        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('should handle fetch errors', async () => {
        browser.storage.local.get.mockResolvedValue({
            pendingVoice: 'af_heart',
            pendingApiUrl: 'http://localhost:8880'
        });
        global.fetch.mockRejectedValue(new Error('Failed to fetch'));

        // Suppress console.error for this test
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        audioManager.setSentences([{ text: 'Error' }]);

        await expect(audioManager.getAudio(0)).rejects.toThrow('Connection failed. Is Kokoro-FastAPI running on http://localhost:8880?');

        consoleSpy.mockRestore();
    });
});
