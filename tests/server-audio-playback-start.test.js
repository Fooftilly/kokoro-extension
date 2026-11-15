/**
 * @jest-environment jsdom
 */
import { waitServerAudioPlaybackStart } from '../server-audio-playback-start.js';

function fakeAudio({ playImpl, initiallyMuted = false } = {}) {
    const listeners = new Map();
    const audio = {
        muted: initiallyMuted,
        currentTime: 1.5,
        pause: jest.fn(),
        play: jest.fn(playImpl || (() => {
            queueMicrotask(() => {
                const handlers = listeners.get('playing') || [];
                for (const handler of handlers.slice()) handler();
            });
            return Promise.resolve();
        })),
        addEventListener: jest.fn((type, handler) => {
            const list = listeners.get(type) || [];
            list.push(handler);
            listeners.set(type, list);
        }),
        removeEventListener: jest.fn((type, handler) => {
            const list = listeners.get(type) || [];
            listeners.set(type, list.filter(h => h !== handler));
        }),
        _listeners: listeners,
    };
    return audio;
}

describe('waitServerAudioPlaybackStart', () => {
    test('waits for playing, pauses, and restores unmuted state', async () => {
        const audio = fakeAudio({ initiallyMuted: false });
        await waitServerAudioPlaybackStart(audio);
        expect(audio.play).toHaveBeenCalled();
        expect(audio.pause).toHaveBeenCalled();
        expect(audio.currentTime).toBe(0);
        expect(audio.muted).toBe(false);
        expect(audio.removeEventListener).toHaveBeenCalledWith(
            'playing', expect.any(Function));
        expect(audio.removeEventListener).toHaveBeenCalledWith(
            'error', expect.any(Function));
        expect(audio._listeners.get('playing') || []).toHaveLength(0);
        expect(audio._listeners.get('error') || []).toHaveLength(0);
    });

    test('restores originally muted state after success', async () => {
        const audio = fakeAudio({ initiallyMuted: true });
        await waitServerAudioPlaybackStart(audio);
        expect(audio.muted).toBe(true);
    });

    test('restores mute state after rejected play()', async () => {
        const audio = fakeAudio({
            initiallyMuted: false,
            playImpl: () => Promise.reject(new Error('NotAllowedError')),
        });
        await expect(waitServerAudioPlaybackStart(audio))
            .rejects.toThrow(/NotAllowedError/);
        expect(audio.muted).toBe(false);
        expect(audio._listeners.get('playing') || []).toHaveLength(0);
        expect(audio._listeners.get('error') || []).toHaveLength(0);
    });

    test('restores mute state after media error event', async () => {
        const audio = fakeAudio({
            initiallyMuted: false,
            playImpl: () => {
                queueMicrotask(() => {
                    const handlers = audio._listeners.get('error') || [];
                    for (const handler of handlers.slice()) handler();
                });
                return Promise.resolve();
            },
        });
        await expect(waitServerAudioPlaybackStart(audio))
            .rejects.toThrow(/failed to start playback/);
        expect(audio.muted).toBe(false);
        expect(audio._listeners.get('playing') || []).toHaveLength(0);
        expect(audio._listeners.get('error') || []).toHaveLength(0);
    });

    test('times out stalled play() with no events, cleans up, restores mute',
        async () => {
            const audio = fakeAudio({
                initiallyMuted: false,
                // Never settles and never emits playing/error.
                playImpl: () => new Promise(() => {}),
            });
            await expect(waitServerAudioPlaybackStart(audio, { timeoutMs: 40 }))
                .rejects.toThrow(/timed out/);
            expect(audio.muted).toBe(false);
            expect(audio.pause).toHaveBeenCalled();
            expect(audio.currentTime).toBe(0);
            expect(audio._listeners.get('playing') || []).toHaveLength(0);
            expect(audio._listeners.get('error') || []).toHaveLength(0);
        });
});
