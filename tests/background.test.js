// Setup global mocks
global.browser = {
    runtime: {
        onInstalled: { addListener: jest.fn() },
        onMessage: { addListener: jest.fn() },
        sendMessage: jest.fn(() => Promise.resolve()),
        getURL: jest.fn(path => `moz-extension://uuid/${path}`)
    },
    contextMenus: {
        create: jest.fn(),
        onClicked: { addListener: jest.fn() }
    },
    notifications: {
        create: jest.fn()
    },
    storage: {
        sync: {
            get: jest.fn(() => Promise.resolve({
                apiUrl: 'http://localhost:8880/v1/',
                voice: 'af_sarah',
                mode: 'stream'
            }))
        },
        local: {
            set: jest.fn(() => Promise.resolve())
        }
    },
    tabs: {
        sendMessage: jest.fn(),
        query: jest.fn(),
        executeScript: jest.fn()
    },
    scripting: {
        executeScript: jest.fn()
    },
    commands: {
        onCommand: { addListener: jest.fn() }
    },
    action: {
        setIcon: jest.fn()
    },
    alarms: {
        create: jest.fn(),
        onAlarm: { addListener: jest.fn() }
    }
};

global.browser.storage.onChanged = { addListener: jest.fn() };

global.fetch = jest.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ models: [] }),
    text: () => Promise.resolve('ok'),
    blob: () => Promise.resolve(new Blob(['audio'], { type: 'audio/mpeg' }))
}));

global.FileReader = class {
    readAsDataURL() { this.onloadend(); }
    get result() { return 'data:audio/mpeg;base64,...'; }
};

describe('background.js logic', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        // Set default mocks for sync get since it's used in every handleTtsAction
        browser.storage.sync.get.mockResolvedValue({
            apiUrl: 'http://localhost:8880/v1/',
            voice: 'af_sarah',
            mode: 'stream',
            normalizationOptions: {}
        });
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ status: 'ok', models: [] }),
            text: async () => 'ok',
            blob: async () => new Blob(['audio'], { type: 'audio/mpeg' })
        });
        // Load the script fresh for each test
        require('../background.js');
    });

    test('Should register context menus on install', async () => {
        const listener = browser.runtime.onInstalled.addListener.mock.calls[0][0];
        listener();
        expect(browser.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'send-to-kokoro' }));
        expect(browser.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'read-article-kokoro' }));
    });

    test('reader navigation shortcuts target only the active extension reader tab', async () => {
        const handler = browser.commands.onCommand.addListener.mock.calls[0][0];
        browser.tabs.query.mockResolvedValue([{ id: 55, url: 'moz-extension://uuid/reader.html' }]);
        await handler('nav-next');
        expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
            action: 'KOKORO_READER_NAV', tabId: 55, direction: 'NAV_NEXT',
        });
        expect(browser.tabs.sendMessage).not.toHaveBeenCalled();

        browser.runtime.sendMessage.mockClear();
        await handler('nav-prev');
        expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
            action: 'KOKORO_READER_NAV', tabId: 55, direction: 'NAV_PREV',
        });
        expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    });

    test('ordinary webpages retain content-script sentence navigation', async () => {
        const handler = browser.commands.onCommand.addListener.mock.calls[0][0];
        browser.tabs.query.mockResolvedValue([{ id: 21, url: 'https://example.com/reader.html' }]);
        browser.tabs.sendMessage.mockResolvedValue();
        await handler('nav-next');
        expect(browser.tabs.sendMessage).toHaveBeenCalledWith(21, { action: 'NAV_NEXT' });
        await handler('nav-prev');
        expect(browser.tabs.sendMessage).toHaveBeenCalledWith(21, { action: 'NAV_PREV' });
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('Should handle selection TTS action', async () => {
        const onClickedListener = browser.contextMenus.onClicked.addListener.mock.calls[0][0];
        const mockTab = { id: 123, title: 'Test Page' };
        const mockInfo = { menuItemId: 'send-to-kokoro', selectionText: 'Hello world' };

        await onClickedListener(mockInfo, mockTab);

        console.log('Local storage set calls:', JSON.stringify(browser.storage.local.set.mock.calls, null, 2));

        expect(browser.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
            pendingText: 'Hello world'
        }));
    });

    test('Should retry content script injection if message fails', async () => {
        const onClickedListener = browser.contextMenus.onClicked.addListener.mock.calls[0][0];
        const mockTab = { id: 124, title: 'Article Page' };
        const mockInfo = { menuItemId: 'read-article-kokoro' };

        // Mock sendMessage failures
        browser.tabs.sendMessage
            .mockRejectedValueOnce(new Error('PARSE_FAIL')) // Initial PARSE_ARTICLE
            .mockRejectedValueOnce(new Error('PING_FAIL'))  // PING in ensureContentScript
            .mockResolvedValueOnce({ text: 'Article content', content: [] }) // Retry PARSE_ARTICLE
            .mockResolvedValueOnce({}); // SHOW_PLAYER

        await onClickedListener(mockInfo, mockTab);

        console.log('SendMessage calls:', browser.tabs.sendMessage.mock.calls.map(c => (c[1] ? c[1].action : 'unknown')));

        expect(browser.scripting.executeScript).toHaveBeenCalled();
        const injectCall = browser.scripting.executeScript.mock.calls.find(
            (call) => call[0] && Array.isArray(call[0].files)
        );
        expect(injectCall).toBeDefined();
        const files = injectCall[0].files;
        expect(files).toEqual([
            'browser-polyfill.min.js',
            'readability.js',
            'overlay-position.js',
            'floating-mic-position.js',
            'content.js'
        ]);
        expect(files.indexOf('overlay-position.js')).toBeLessThan(files.indexOf('content.js'));
        expect(files.indexOf('floating-mic-position.js')).toBeLessThan(files.indexOf('content.js'));
    });

    test.each(['', 'not a valid server URL', undefined])(
        'ONNX selection routes to local overlay without a usable server (%s)', async apiUrl => {
            browser.storage.sync.get.mockResolvedValue({
                ttsBackend: 'onnx', apiUrl,
                voice: 'af_sarah', mode: 'stream', normalizationOptions: {},
            });
            const listener = browser.contextMenus.onClicked.addListener.mock.calls[0][0];
            await listener(
                { menuItemId: 'send-to-kokoro', selectionText: 'Private selection' },
                { id: 7, title: 'Private page' }
            );
            expect(browser.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
                pendingTtsBackend: 'onnx', pendingText: 'Private selection',
                pendingApiUrl: null,
            }));
            expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
                7, expect.objectContaining({ action: 'SHOW_PLAYER' })
            );
            expect(fetch.mock.calls.some(([url]) => String(url).includes('/audio/speech'))).toBe(false);
        }
    );

    test('ONNX article action opens full local player and never sends server audio', async () => {
        browser.storage.sync.get.mockResolvedValue({
            ttsBackend: 'onnx', apiUrl: 'http://private-server.example/v1/',
            mode: 'stream', normalizationOptions: {},
        });
        browser.tabs.sendMessage.mockResolvedValue({ text: 'Hello world.',
            content: [{ type: 'text', content: 'Hello world.' }] });
        const listener = browser.contextMenus.onClicked.addListener.mock.calls[0][0];
        await listener({ menuItemId: 'read-article-kokoro' },
            { id: 19, title: 'Article' });
        expect(browser.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
            pendingTtsBackend: 'onnx', pendingText: 'Hello world.',
            pendingApiUrl: null,
        }));
        expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
            19, { action: 'SHOW_PLAYER', mode: 'full' }
        );
        expect(fetch.mock.calls.some(([url]) => String(url).includes('/audio/speech'))).toBe(false);
    });

    test('MediaPipe playback migrates legacy localVoice when mediaPipeVoice is unset (#59)', async () => {
        browser.storage.sync.get.mockImplementation(async (defaults = {}) => ({
            ...defaults,
            ttsBackend: 'mediapipe',
            apiUrl: 'http://127.0.0.1:8880/v1/',
            mediaPipeVariant: 'cpu',
            localVoice: 'af_bella',
            voice: 'af_sarah(5)+af_nicole(3)',
            mode: 'stream',
            normalizationOptions: {},
        }));
        const listener = browser.contextMenus.onClicked.addListener.mock.calls[0][0];
        await listener(
            { menuItemId: 'send-to-kokoro', selectionText: 'Legacy voice upgrade' },
            { id: 27, title: 'Upgrade page' }
        );
        expect(browser.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
            pendingTtsBackend: 'mediapipe',
            pendingLocalVoice: 'af_bella',
        }));
        const getArg = browser.storage.sync.get.mock.calls.at(-1)[0];
        expect(Object.hasOwn(getArg, 'mediaPipeVoice')).toBe(false);
    });

    test.each(['', 'not a valid server URL', undefined])(
        'MediaPipe selection works without a usable server URL (%s)', async apiUrl => {
            browser.storage.sync.get.mockResolvedValue({
                ttsBackend: 'mediapipe', apiUrl, mediaPipeVariant: 'cpu',
                localVoice: 'af_heart', voice: 'af_sarah', mode: 'stream',
                normalizationOptions: {},
            });
            const listener = browser.contextMenus.onClicked.addListener.mock.calls[0][0];
            await listener(
                { menuItemId: 'send-to-kokoro', selectionText: 'Private offline sentence' },
                { id: 17, title: 'Private page' }
            );
            expect(browser.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
                pendingTtsBackend: 'mediapipe',
                pendingText: 'Private offline sentence',
                pendingApiUrl: null,
            }));
            expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
                17, expect.objectContaining({ action: 'SHOW_PLAYER' })
            );
            // Background startup may independently check a server health URL.
            // Offline synthesis must never send speech text or request server audio.
            expect(fetch.mock.calls.every(([url]) => !String(url).includes('/audio/speech'))).toBe(true);
        }
    );

    test('MediaPipe download mode remains offline and tells users how to save WAV', async () => {
        browser.storage.sync.get.mockResolvedValue({
            ttsBackend: 'mediapipe',
            apiUrl: 'http://private-server.example/v1/',
            mediaPipeVariant: 'cpu', localVoice: 'af_heart',
            voice: 'af_sarah', mode: 'download', normalizationOptions: {},
        });
        const listener = browser.contextMenus.onClicked.addListener.mock.calls[0][0];
        fetch.mockClear();
        await listener({ menuItemId: 'send-to-kokoro', selectionText: 'Local text' },
            { id: 18, title: 'Local selection' });
        expect(browser.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
            pendingTtsBackend: 'mediapipe', pendingApiUrl: null,
            pendingText: 'Local text',
        }));
        expect(browser.tabs.sendMessage).toHaveBeenCalledWith(18,
            expect.objectContaining({ action: 'SHOW_PLAYER' }));
        expect(browser.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Save audio'),
        }));
        expect(fetch).not.toHaveBeenCalled();
        expect(browser.downloads).toBeUndefined();
    });

    test('capability discovery is read-only and never probes FastAPI or local models', async () => {
        const listener = browser.runtime.onMessage.addListener.mock.calls[0][0];
        fetch.mockClear();
        browser.storage.sync.get.mockClear();
        const result = await listener({ action: 'GET_TTS_BACKEND_CAPABILITIES' }, {});
        expect(result.success).toBe(true);
        expect(result.capabilities.map(entry => entry.id))
            .toEqual(['fastapi', 'mediapipe', 'onnx']);
        expect(result.capabilities[1]).toEqual(expect.objectContaining({
            execution: 'on-device',
            modelStatus: 'not-checked',
            readiness: 'requires-runtime-check',
        }));
        expect(result.capabilities[2].phonemeSynthesis).toBe('diagnostic-only');
        expect(fetch).not.toHaveBeenCalled();
        expect(browser.storage.sync.get).not.toHaveBeenCalled();
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('capabilities can be queried for one backend without falling back to server', async () => {
        const listener = browser.runtime.onMessage.addListener.mock.calls[0][0];
        fetch.mockClear();
        expect(await listener({
            action: 'GET_TTS_BACKEND_CAPABILITIES', backend: 'onnx',
        }, {})).toEqual({
            success: true, capabilities: [expect.objectContaining({
                id: 'onnx', execution: 'on-device', textSynthesis: 'experimental',
            })],
        });
        expect(await listener({
            action: 'GET_TTS_BACKEND_CAPABILITIES', backend: 'untrusted',
        }, {})).toEqual(expect.objectContaining({
            success: false, kind: 'invalid-backend',
        }));
        expect(fetch).not.toHaveBeenCalled();
    });

    test('local fetch messages cannot fall through to FastAPI HTTP', async () => {
        browser.storage.sync.get.mockResolvedValue({ ttsBackend: 'mediapipe' });
        const handler = browser.runtime.onMessage.addListener.mock.calls[0][0];
        const result = await handler({
            action: 'FETCH_TTS_AUDIO', backend: 'mediapipe',
            endpoint: 'http://localhost:8880/v1/audio/speech',
            payload: { input: 'Private text' },
        }, {});
        expect(result).toMatchObject({
            success: false, kind: 'local-backend-not-installed', backend: 'mediapipe',
        });
        expect(fetch.mock.calls.some(([url]) => String(url).includes('/audio/speech'))).toBe(false);
    });

    test('Should handle FETCH_TTS_AUDIO message', async () => {
        const onMessageListener = browser.runtime.onMessage.addListener.mock.calls[0][0];
        const mockRequest = {
            action: 'FETCH_TTS_AUDIO',
            endpoint: 'http://localhost:8880/v1/audio/speech',
            payload: { input: 'Test' }
        };

        const result = await onMessageListener(mockRequest, {});

        expect(result.success).toBe(true);
        expect(result.dataUrl).toBe('data:audio/mpeg;base64,...');
        expect(global.fetch).toHaveBeenCalledWith(
            'http://localhost:8880/v1/audio/speech',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ input: 'Test' })
            })
        );
    });
});
