// Setup global mocks
global.browser = {
    runtime: {
        onInstalled: { addListener: jest.fn() },
        onMessage: { addListener: jest.fn() },
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
