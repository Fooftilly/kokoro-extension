// Setup global mocks
global.browser = {
    storage: {
        local: {
            get: jest.fn(() => Promise.resolve({
                pendingText: 'Hello world',
                pendingContent: [{ type: 'text', content: 'Hello world' }],
                pendingVoice: 'af_sarah',
                pendingApiUrl: 'http://localhost:8880/v1/',
                pendingTitle: 'Test Title'
            })),
            set: jest.fn(() => Promise.resolve()),
            remove: jest.fn(() => Promise.resolve()),
        },
        sync: {
            get: jest.fn(() => Promise.resolve({
                apiUrl: 'http://localhost:8880/v1/',
                voice: 'af_sarah',
                mode: 'stream',
                normalizationOptions: {}
            }))
        },
        onChanged: { addListener: jest.fn() }
    },
    downloads: {
        download: jest.fn(() => Promise.resolve(1)),
    },
    runtime: {
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
    }
};

// Mock DOMPurify
global.window = global;
global.window.DOMPurify = {
    sanitize: jest.fn(html => html)
};
global.window.focus = jest.fn();
global.window.parent = {
    postMessage: jest.fn()
};

// Mock HTMLMediaElement methods to silence JSDOM "not implemented" errors
window.HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue();
window.HTMLMediaElement.prototype.pause = jest.fn();
window.HTMLMediaElement.prototype.load = jest.fn();

// Mock AudioManager and processContent
jest.mock('../audio-manager.js', () => ({
    AudioManager: jest.fn().mockImplementation(() => ({
        play: jest.fn().mockResolvedValue(),
        pause: jest.fn(),
        stop: jest.fn(),
        clear: jest.fn(),
        setVoice: jest.fn(),
        setSentences: jest.fn(),
        setApiUrl: jest.fn(),
        setNormalizationOptions: jest.fn(),
        setCustomPronunciations: jest.fn(),
        getAudio: jest.fn().mockResolvedValue('blob:url'),
        pinAudio: jest.fn(() => jest.fn()),
        retainWindow: jest.fn(),
        prioritizeNavigation: jest.fn(),
        prefetch: jest.fn(),
        on: jest.fn()
    }))
}));

const mockSentences = [
    { index: 0, text: 'Hello', html: 'Hello', blockIndex: 0,
        sourceText: 'Original 5 kg.', sourceBlockText: 'Original 5 kg. Context.' },
    { index: 1, text: 'Next sentence', html: 'Next sentence', blockIndex: 1,
        sourceText: 'Next original sentence.', sourceBlockText: 'Next original sentence.' },
];
jest.mock('../text-processor.js', () => ({
    processContent: jest.fn(() => ({
        sentences: mockSentences,
        renderData: [{ type: 'paragraph', sentences: mockSentences }]
    }))
}));

// Mock scrollIntoView
Element.prototype.scrollIntoView = jest.fn();

function installExportAudioFetchMock() {
    const { encodePcm16Wav } = require('../pcm-wav.js');
    const samples = new Float32Array(48);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 10) * 0.25;
    const wavBytes = encodePcm16Wav(samples, 24000);
    const mp3Bytes = Uint8Array.from(Buffer.from('fake-mp3-bytes'));

    global.fetch = jest.fn(async (url) => {
        const asString = String(url);
        const isMp3 = /mpeg|mp3/i.test(asString);
        const body = isMp3 ? mp3Bytes : wavBytes;
        return {
            ok: true,
            headers: {
                get: (name) => {
                    if (String(name).toLowerCase() !== 'content-type') return null;
                    return isMp3 ? 'audio/mpeg' : 'audio/wav';
                },
            },
            arrayBuffer: async () => body.buffer.slice(
                body.byteOffset, body.byteOffset + body.byteLength),
        };
    });
    if (!URL.createObjectURL || !jest.isMockFunction(URL.createObjectURL)) {
        URL.createObjectURL = jest.fn(() => 'blob:export-download');
    } else {
        URL.createObjectURL.mockReturnValue('blob:export-download');
    }
    if (!URL.revokeObjectURL || !jest.isMockFunction(URL.revokeObjectURL)) {
        URL.revokeObjectURL = jest.fn();
    }
}

function setupDOM() {
    document.body.className = '';
    document.body.innerHTML = `
        <div id="dragHandle">
            <span class="drag-grip">⋮⋮</span>
            <div class="title-stack">
                <div id="pageTitle">Kokoro TTS</div>
                <span id="backendBadge" class="backend-badge" hidden></span>
            </div>
        </div>
        <button id="collapse" aria-label="Collapse player">–</button>
        <button id="close">×</button>
        <div id="progressBar"></div>
        <div id="timeEstimate"></div>
        <div id="loadingSpinner"></div>
        <div id="status">Ready</div>
        <div id="text-display"></div>
        <audio id="audio"></audio>
        <button id="playPause" aria-label="Pause playback">Pause</button>
        <button id="seekBack" aria-label="Previous sentence">Prev</button>
        <button id="seekFwd" aria-label="Next sentence">Next</button>
        <input type="range" id="volumeControl" value="1" aria-label="Volume">
        <button id="retry" aria-label="Retry playback"></button>
        <div class="export-controls">
            <select id="exportScope" aria-label="Export scope">
                <option value="sentence" selected>Current sentence</option>
                <option value="article">Full article</option>
            </select>
            <button id="saveAudio" aria-label="Save audio export"></button>
            <button id="cancelExport" aria-label="Cancel audio export" hidden>Cancel</button>
        </div>
        <div id="exportProgress" hidden>
            <div id="exportProgressFill"></div>
            <span id="exportProgressLabel"></span>
        </div>
        <select id="speed" aria-label="Playback speed">
            <option value="1.0">1.0x</option>
        </select>
    `;
}

describe('overlay.js logic', () => {
    let overlayWindowListeners = [];

    beforeEach(() => {
        // jest.resetModules() does not detach event handlers installed by an
        // earlier overlay.js instance. Preserve only this test's listeners so
        // RELOAD_DATA is delivered once, as it is in a real extension iframe.
        for (const { type, listener, options } of overlayWindowListeners) {
            window.removeEventListener(type, listener, options);
        }
        overlayWindowListeners = [];
        jest.resetModules();
        jest.clearAllMocks();
        setupDOM();
        installExportAudioFetchMock();
        const addListener = window.addEventListener;
        window.addEventListener = function (type, listener, options) {
            overlayWindowListeners.push({ type, listener, options });
            return addListener.call(this, type, listener, options);
        };
        try {
            require('../overlay.js');
        } finally {
            window.addEventListener = addListener;
        }
    });

    afterAll(() => {
        for (const { type, listener, options } of overlayWindowListeners) {
            window.removeEventListener(type, listener, options);
        }
        overlayWindowListeners = [];
    });

    test('Initializes correctly', async () => {
        await new Promise(r => setTimeout(r, 100)); // Wait for async init
        const textDisplay = document.getElementById('text-display');
        expect(textDisplay.textContent).toContain('Hello');
    });

    test('EPUB iframe acknowledges chapter revision only after its content is rendered', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const previousUrl = window.location.pathname + window.location.search;
        try {
            window.history.replaceState({}, '', '/overlay.html?waitForData=true');
            window.parent.postMessage.mockClear();
            browser.storage.local.get.mockResolvedValueOnce({
                pendingText: 'Fresh EPUB chapter',
                pendingContent: [{ type: 'text', content: 'Fresh EPUB chapter' }],
                pendingTitle: 'Book B',
                pendingAutoplay: false,
                pendingStartIndex: 1,
                pendingReaderReloadRevision: 42,
            });
            window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(document.getElementById('pageTitle').textContent).toBe('Book B');
            expect(document.getElementById('text-display').textContent).toContain('Hello');
            expect(window.parent.postMessage.mock.calls.some(([message]) =>
                message?.type === 'KOKORO_READER_RELOAD_READY' &&
                message.revision === 42)).toBe(true);
            const readyAt = window.parent.postMessage.mock.calls.findIndex(([message]) =>
                message?.type === 'KOKORO_READER_RELOAD_READY' &&
                message.revision === 42);
            expect(readyAt).toBeGreaterThanOrEqual(0);
            // No progress for this revision may precede READY (including other blocks).
            const progressBeforeReady = window.parent.postMessage.mock.calls
                .slice(0, readyAt)
                .some(([message]) =>
                    message?.type === 'KOKORO_READING_PROGRESS' &&
                    message.revision === 42);
            expect(progressBeforeReady).toBe(false);
            const progressAt = window.parent.postMessage.mock.calls.findIndex(([message]) =>
                message?.type === 'KOKORO_READING_PROGRESS' &&
                message.revision === 42 &&
                message.blockIndex === 1);
            expect(progressAt).toBeGreaterThan(readyAt);

            // Invalid revisions are never acknowledged as a successful read.
            window.parent.postMessage.mockClear();
            browser.storage.local.get.mockResolvedValueOnce({
                pendingText: 'Another EPUB chapter',
                pendingContent: [{ type: 'text', content: 'Another EPUB chapter' }],
                pendingTitle: 'Book C',
                pendingAutoplay: false,
                pendingReaderReloadRevision: '42',
            });
            window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(window.parent.postMessage.mock.calls.some(([message]) =>
                message?.type === 'KOKORO_READER_RELOAD_READY')).toBe(false);
        } finally {
            window.history.replaceState({}, '', previousUrl);
        }
    });

    test('Handles play/pause button', async () => {
        await new Promise(r => setTimeout(r, 100));
        const audio = document.getElementById('audio');
        const playPauseBtn = document.getElementById('playPause');

        // Mock audio.paused
        Object.defineProperty(audio, 'paused', { value: true, configurable: true });
        audio.play = jest.fn().mockResolvedValue();

        playPauseBtn.click();
        expect(audio.play).toHaveBeenCalled();
    });

    test('native play/pause events keep playPause aria-label in sync', async () => {
        await new Promise(r => setTimeout(r, 50));
        // Start paused so navigate()/autoplay cannot pre-set Pause and mask the handler.
        browser.storage.local.get.mockResolvedValueOnce({
            pendingText: 'Hello world',
            pendingContent: [{ type: 'text', content: 'Hello world' }],
            pendingTitle: 'Test Title',
            pendingAutoplay: false,
        });
        window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
        await new Promise(r => setTimeout(r, 0));

        const audio = document.getElementById('audio');
        const playPauseBtn = document.getElementById('playPause');
        expect(playPauseBtn.textContent).toBe('Play');
        expect(playPauseBtn.getAttribute('aria-label')).toBe('Play playback');

        Object.defineProperty(audio, 'ended', { value: false, configurable: true });
        Object.defineProperty(audio, 'currentTime', { value: 1, configurable: true });
        Object.defineProperty(audio, 'duration', { value: 10, configurable: true });

        audio.dispatchEvent(new Event('play'));
        expect(playPauseBtn.textContent).toBe('Pause');
        expect(playPauseBtn.getAttribute('aria-label')).toBe('Pause playback');

        audio.dispatchEvent(new Event('pause'));
        expect(playPauseBtn.textContent).toBe('Play');
        expect(playPauseBtn.getAttribute('aria-label')).toBe('Play playback');
    });

    test('blocked EPUB autoplay explains the required Play gesture and recovers after Play', async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const previousUrl = window.location.pathname + window.location.search;
        try {
            window.history.replaceState({}, '', '/overlay.html?waitForData=true');
            const audio = document.getElementById('audio');
            const denied = Object.assign(new Error('Autoplay denied'), { name: 'NotAllowedError' });
            audio.play = jest.fn().mockRejectedValueOnce(denied).mockResolvedValue();
            browser.storage.local.get.mockResolvedValueOnce({
                pendingText: 'Opening chapter',
                pendingContent: [{ type: 'text', content: 'Opening chapter' }],
                pendingTitle: 'EPUB chapter',
                pendingAutoplay: true,
                pendingReaderReloadRevision: 301,
            });
            window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(audio.play).toHaveBeenCalledTimes(1);
            expect(document.getElementById('playPause').textContent).toBe('Play');
            expect(document.getElementById('status').textContent).toBe(
                'Browser blocked autoplay. Click Play to start.');

            document.getElementById('playPause').click();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(audio.play).toHaveBeenCalledTimes(2);
            expect(document.getElementById('playPause').textContent).toBe('Pause');
            expect(document.getElementById('status').textContent)
                .toContain('Playing sentence');
        } finally {
            window.history.replaceState({}, '', previousUrl);
        }
    });

    test('EPUB autoplay disabled loads paused without attempting browser playback', async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const previousUrl = window.location.pathname + window.location.search;
        try {
            window.history.replaceState({}, '', '/overlay.html?waitForData=true');
            const audio = document.getElementById('audio');
            audio.play = jest.fn().mockResolvedValue();
            browser.storage.local.get.mockResolvedValueOnce({
                pendingText: 'Paused chapter',
                pendingContent: [{ type: 'text', content: 'Paused chapter' }],
                pendingAutoplay: false,
                pendingReaderReloadRevision: 302,
            });
            window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(audio.play).not.toHaveBeenCalled();
            expect(document.getElementById('playPause').textContent).toBe('Play');
            expect(document.getElementById('status').textContent)
                .not.toContain('blocked autoplay');
        } finally {
            window.history.replaceState({}, '', previousUrl);
        }
    });

    test('a blocked manual Play action also has a visible retry explanation', async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const audio = document.getElementById('audio');
        Object.defineProperty(audio, 'paused', { configurable: true, value: true });
        audio.play = jest.fn().mockRejectedValueOnce(
            Object.assign(new Error('Browser denied play'), { name: 'NotAllowedError' }));
        document.getElementById('playPause').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(document.getElementById('playPause').textContent).toBe('Play');
        expect(document.getElementById('status').textContent)
            .toBe('Browser blocked autoplay. Click Play to start.');
    });

    test('Auto-scroll toggles apply on the next sentence without recreating the player', async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const listener = browser.storage.onChanged.addListener.mock.calls.at(-1)[0];
        window.parent.postMessage.mockClear();
        listener({ autoScroll: { oldValue: false, newValue: true } }, 'local');
        document.querySelectorAll('.sentence')[1].click();
        expect(window.parent.postMessage).toHaveBeenCalledWith({
            action: 'KOKORO_SCROLL_TO_BLOCK',
            text: 'Next original sentence.',
            blockText: 'Next original sentence.',
        }, '*');

        listener({ autoScroll: { oldValue: true, newValue: false } }, 'local');
        window.parent.postMessage.mockClear();
        document.querySelectorAll('.sentence')[0].click();
        expect(window.parent.postMessage.mock.calls.some(([data]) =>
            data?.action === 'KOKORO_SCROLL_TO_BLOCK')).toBe(false);
    });

    test('a late chapter reload cannot revert a newer live Auto-scroll toggle', async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        let resolveStorage;
        browser.storage.local.get.mockImplementationOnce(() => new Promise(resolve => {
            resolveStorage = resolve;
        }));
        window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
        await Promise.resolve();
        expect(typeof resolveStorage).toBe('function');

        const listener = browser.storage.onChanged.addListener.mock.calls.at(-1)[0];
        listener({ autoScroll: { oldValue: false, newValue: true } }, 'local');
        resolveStorage({
            pendingText: 'Delayed original article',
            pendingContent: [{ type: 'text', content: 'Delayed original article' }],
            autoScroll: false,
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(window.kokoroAutoScroll).toBe(true);
        window.parent.postMessage.mockClear();
        document.querySelectorAll('.sentence')[0].click();
        expect(window.parent.postMessage.mock.calls.some(([data]) =>
            data?.action === 'KOKORO_SCROLL_TO_BLOCK')).toBe(true);
    });

    test('document-reader iframe does not send origin-page auto-scroll requests', async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const url = window.location.pathname + window.location.search;
        try {
            window.history.replaceState({}, '', '/overlay.html?waitForData=true');
            const listener = browser.storage.onChanged.addListener.mock.calls.at(-1)[0];
            listener({ autoScroll: { newValue: true } }, 'local');
            window.parent.postMessage.mockClear();
            document.querySelectorAll('.sentence')[0].click();
            expect(window.parent.postMessage.mock.calls.some(([data]) =>
                data?.action === 'KOKORO_SCROLL_TO_BLOCK')).toBe(false);
        } finally {
            window.history.replaceState({}, '', url);
        }
    });

    test('an obsolete storage read cannot restore a previous EPUB chapter', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results[0].value;
        let resolveOld;
        browser.storage.local.get.mockImplementationOnce(() =>
            new Promise(resolve => { resolveOld = resolve; }))
            .mockResolvedValueOnce({
                pendingText: 'Fresh chapter',
                pendingContent: [{ type: 'text', content: 'Fresh chapter' }],
                pendingTitle: 'Chapter B',
                pendingAutoplay: false,
            });

        window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
        await Promise.resolve();
        expect(typeof resolveOld).toBe('function');
        window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(document.getElementById('pageTitle').textContent).toBe('Chapter B');
        const synthesisCount = manager.getAudio.mock.calls.length;
        resolveOld({
            pendingText: 'Stale chapter',
            pendingContent: [{ type: 'text', content: 'Stale chapter' }],
            pendingTitle: 'Chapter A',
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(document.getElementById('pageTitle').textContent).toBe('Chapter B');
        expect(manager.getAudio).toHaveBeenCalledTimes(synthesisCount);
        expect(document.getElementById('status').textContent)
            .toContain('Playing sentence');
    });

    test('download filename retains the sentence selected before asynchronous synthesis', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results[0].value;
        let resolveAudio;
        manager.getAudio.mockReturnValueOnce(new Promise(resolve => { resolveAudio = resolve; }));

        document.getElementById('saveAudio').click();
        await Promise.resolve();
        expect(manager.getAudio).toHaveBeenCalledWith(0);
        document.getElementById('seekFwd').click();
        resolveAudio('blob:the-original-sentence');
        await new Promise(resolve => setTimeout(resolve, 0));
        // Export copies bytes into a fresh blob URL for downloads.download;
        // the filename still reflects the sentence that was pinned for save.
        expect(browser.downloads.download).toHaveBeenCalledWith(expect.objectContaining({
            url: 'blob:export-download',
            filename: expect.stringMatching(/-sentence-1\.mp3$/),
        }));
    });

    test('rapid navigation does not let a stale rejection overwrite newer playback', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results[0].value;
        let rejectOld;
        manager.getAudio.mockReset();
        manager.getAudio
            .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
            .mockResolvedValueOnce('blob:fresh-selection');
        const logger = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            document.getElementById('seekFwd').click();
            await Promise.resolve();
            document.getElementById('seekBack').click();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(document.getElementById('audio').getAttribute('src'))
                .toBe('blob:fresh-selection');
            rejectOld(new Error('Obsolete synth failed'));
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(document.getElementById('status').textContent)
                .toContain('Playing sentence 1/2');
            expect(document.getElementById('loadingSpinner').style.display).toBe('none');
            expect(logger).not.toHaveBeenCalledWith(
                'Playback error', expect.objectContaining({ message: 'Obsolete synth failed' }));
            expect(manager.prioritizeNavigation).toHaveBeenCalledWith(1);
            expect(manager.prioritizeNavigation).toHaveBeenCalledWith(0);
        } finally {
            logger.mockRestore();
        }
    });

    test('Retry appears for current playback failure and recovers after user action', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results[0].value;
        const retry = document.getElementById('retry');
        const logger = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(retry.style.display).toBe('none');
            manager.getAudio.mockRejectedValueOnce(new Error('Unsupported English word'));
            document.getElementById('seekFwd').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(document.getElementById('status').textContent).toMatch(/^Error playing audio/);
            expect(document.getElementById('playPause').textContent).toBe('Play');
            // Play must not resume the preceding sentence under the failed
            // sentence's highlight.
            expect(document.getElementById('audio').hasAttribute('src')).toBe(false);
            expect(retry.style.display).toBe('inline-flex');

            // Clicking the visible recovery control reinitializes the session.
            manager.getAudio.mockResolvedValueOnce('blob:recovered-after-error');
            const initialClearCount = manager.clear.mock.calls.length;
            retry.click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(manager.clear.mock.calls.length).toBe(initialClearCount + 1);
            expect(document.getElementById('audio').getAttribute('src'))
                .toBe('blob:recovered-after-error');
            expect(retry.style.display).toBe('none');
        } finally {
            logger.mockRestore();
        }
    });

    test('successful navigation dismisses Retry after a failed sentence', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results[0].value;
        const logger = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            manager.getAudio.mockRejectedValueOnce(new Error('Unsupported English word'));
            document.getElementById('seekFwd').click();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(document.getElementById('retry').style.display).toBe('inline-flex');

            manager.getAudio.mockResolvedValueOnce('blob:previous-good-sentence');
            document.getElementById('seekBack').click();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(document.getElementById('retry').style.display).toBe('none');
            expect(document.getElementById('audio').getAttribute('src'))
                .toBe('blob:previous-good-sentence');
        } finally {
            logger.mockRestore();
        }
    });

    test('stale success cannot replace playback after navigating back to the same index', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results[0].value;
        let resolveOld;
        manager.getAudio.mockReset();
        manager.getAudio
            .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
            .mockResolvedValueOnce('blob:latest-request');

        const spans = document.querySelectorAll('.sentence');
        spans[0].click();
        await Promise.resolve();
        spans[0].click();
        await new Promise(resolve => setTimeout(resolve, 0));
        resolveOld('blob:stale-request');
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(document.getElementById('audio').getAttribute('src'))
            .toBe('blob:latest-request');
        expect(manager.retainWindow).toHaveBeenCalledWith(0);
    });

    test('pins a local audio URL until Chrome/Firefox reports download completion', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results[0].value;
        const release = jest.fn();
        manager.pinAudio.mockReturnValue(release);
        const listeners = new Set();
        browser.downloads.onChanged = {
            addListener: jest.fn(fn => listeners.add(fn)),
            removeListener: jest.fn(fn => listeners.delete(fn)),
        };
        browser.downloads.download.mockResolvedValue(17);

        document.getElementById('saveAudio').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(manager.pinAudio).toHaveBeenCalledWith(0);
        expect(release).not.toHaveBeenCalled();
        expect(listeners.size).toBe(1);
        for (const fn of [...listeners]) fn({ id: 18, state: { current: 'complete' } });
        expect(release).not.toHaveBeenCalled();
        for (const fn of [...listeners]) fn({ id: 17, state: { current: 'complete' } });
        expect(release).toHaveBeenCalledTimes(1);
        expect(listeners.size).toBe(0);
        delete browser.downloads.onChanged;
    });

    test('failed browser download releases the pinned audio URL', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results[0].value;
        const release = jest.fn();
        manager.pinAudio.mockReturnValue(release);
        const listeners = new Set();
        browser.downloads.onChanged = {
            addListener: jest.fn(fn => listeners.add(fn)),
            removeListener: jest.fn(fn => listeners.delete(fn)),
        };
        browser.downloads.download.mockRejectedValueOnce(new Error('Download rejected'));
        document.getElementById('saveAudio').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(release).toHaveBeenCalled();
        expect(listeners.size).toBe(0);
        expect(document.getElementById('status').textContent).toContain('Could not save audio');
        delete browser.downloads.onChanged;
    });

    test('local ONNX sentence downloads retain WAV format', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        // Save reads pendingTtsBackend after the initial overlay initialize get().
        browser.storage.local.get.mockResolvedValueOnce({ pendingTtsBackend: 'onnx' });
        document.getElementById('saveAudio').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const call = browser.downloads.download.mock.calls[0][0];
        expect(call.filename.endsWith('-sentence-1.wav')).toBe(true);
    });

    test('full article export scope is offered for webpage overlays', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const select = document.getElementById('exportScope');
        const values = [...select.options].map(o => o.value);
        expect(values).toContain('sentence');
        expect(values).toContain('article');
        expect(values).not.toContain('document');
    });

    test('cancel export aborts an in-flight multi-sentence save', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results[0].value;
        manager.audioCache = new Map();
        manager.evictAudio = jest.fn();
        let resolveAudio;
        manager.getAudio.mockReset();
        manager.getAudio.mockImplementation(
            () => new Promise(resolve => { resolveAudio = resolve; }));
        browser.storage.local.get.mockResolvedValueOnce({
            pendingTtsBackend: 'mediapipe',
        });
        document.getElementById('exportScope').value = 'article';
        document.getElementById('saveAudio').click();
        await Promise.resolve();
        await Promise.resolve();
        expect(typeof resolveAudio).toBe('function');
        document.getElementById('cancelExport').click();
        resolveAudio('blob:partial');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(document.getElementById('status').textContent)
            .toMatch(/cancel/i);
        expect(browser.downloads.download).not.toHaveBeenCalled();
    });

    test('Handles navigation calls correctly', async () => {
        await new Promise(r => setTimeout(r, 100));
        const seekFwdBtn = document.getElementById('seekFwd');
        seekFwdBtn.click();

        expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });

    test('Collapse posts SET_COLLAPSED without closing; expand toggles label', async () => {
        await new Promise(r => setTimeout(r, 100));
        const collapseBtn = document.getElementById('collapse');
        window.parent.postMessage.mockClear();

        collapseBtn.click();
        expect(window.parent.postMessage).toHaveBeenCalledWith(
            { action: 'KOKORO_SET_COLLAPSED', collapsed: true },
            '*'
        );
        expect(window.parent.postMessage).not.toHaveBeenCalledWith('CLOSE_KOKORO_PLAYER', '*');

        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_OVERLAY_STATE', mode: 'popup', collapsed: true, draggable: true }
        }));
        expect(document.body.classList.contains('collapsed')).toBe(true);
        expect(collapseBtn.getAttribute('aria-label')).toBe('Expand player');

        window.parent.postMessage.mockClear();
        collapseBtn.click();
        expect(window.parent.postMessage).toHaveBeenCalledWith(
            { action: 'KOKORO_SET_COLLAPSED', collapsed: false },
            '*'
        );
    });

    test('Drag handle captures pointer and forwards move/end (touch/pen style)', async () => {
        await new Promise(r => setTimeout(r, 100));
        const dragHandle = document.getElementById('dragHandle');
        dragHandle.setPointerCapture = jest.fn();
        dragHandle.releasePointerCapture = jest.fn();

        // Host must opt in before floating chrome is interactive
        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_OVERLAY_STATE', mode: 'popup', collapsed: false, draggable: true }
        }));
        window.parent.postMessage.mockClear();

        const firePointer = (type, el, props) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, {
                pointerId: { value: props.pointerId ?? 7 },
                pointerType: { value: props.pointerType ?? 'touch' },
                button: { value: props.button ?? 0 },
                clientX: { value: props.clientX ?? 0 },
                clientY: { value: props.clientY ?? 0 },
                screenX: { value: props.screenX ?? 0 },
                screenY: { value: props.screenY ?? 0 },
                target: { value: el },
            });
            el.dispatchEvent(event);
            return event;
        };

        firePointer('pointerdown', dragHandle, {
            pointerType: 'touch',
            screenX: 900,
            screenY: 80,
            clientX: 40,
            clientY: 20
        });
        expect(dragHandle.setPointerCapture).toHaveBeenCalledWith(7);
        expect(window.parent.postMessage).toHaveBeenCalledWith(
            { action: 'KOKORO_DRAG_START' },
            '*'
        );

        window.parent.postMessage.mockClear();
        firePointer('pointermove', dragHandle, {
            pointerType: 'touch',
            screenX: 860,
            screenY: 100,
            clientX: 20,
            clientY: 40
        });
        expect(window.parent.postMessage).toHaveBeenCalledWith(
            { action: 'KOKORO_DRAG_MOVE', dx: -40, dy: 20 },
            '*'
        );

        window.parent.postMessage.mockClear();
        firePointer('pointerup', dragHandle, {
            pointerType: 'touch',
            screenX: 860,
            screenY: 100
        });
        expect(dragHandle.releasePointerCapture).toHaveBeenCalledWith(7);
        expect(window.parent.postMessage).toHaveBeenCalledWith(
            { action: 'KOKORO_DRAG_END' },
            '*'
        );
    });

    test('Drag handle posts DRAG_START only when host supports floating chrome', async () => {
        await new Promise(r => setTimeout(r, 100));
        const dragHandle = document.getElementById('dragHandle');
        dragHandle.setPointerCapture = jest.fn();
        dragHandle.releasePointerCapture = jest.fn();
        window.parent.postMessage.mockClear();

        const firePointerDown = (el, clientX, clientY) => {
            const event = new Event('pointerdown', { bubbles: true, cancelable: true });
            Object.defineProperties(event, {
                pointerId: { value: 1 },
                clientX: { value: clientX },
                clientY: { value: clientY },
                screenX: { value: clientX },
                screenY: { value: clientY },
                button: { value: 0 },
                target: { value: el },
            });
            el.dispatchEvent(event);
        };

        // No host state yet (EPUB reader path) — drag must not start
        firePointerDown(dragHandle, 40, 50);
        expect(window.parent.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'KOKORO_DRAG_START' }),
            '*'
        );

        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_OVERLAY_STATE', mode: 'popup', collapsed: false, draggable: true }
        }));
        expect(document.body.classList.contains('has-host-overlay-state')).toBe(true);

        window.parent.postMessage.mockClear();
        firePointerDown(dragHandle, 40, 50);
        expect(window.parent.postMessage).toHaveBeenCalledWith(
            { action: 'KOKORO_DRAG_START' },
            '*'
        );

        window.parent.postMessage.mockClear();
        firePointerDown(document.getElementById('close'), 10, 10);
        expect(window.parent.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'KOKORO_DRAG_START' }),
            '*'
        );

        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_OVERLAY_STATE', mode: 'full', collapsed: false, draggable: false }
        }));
        window.parent.postMessage.mockClear();
        firePointerDown(dragHandle, 40, 50);
        expect(window.parent.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'KOKORO_DRAG_START' }),
            '*'
        );
    });

    test('Collapse chrome is gated until host overlay state arrives', async () => {
        await new Promise(r => setTimeout(r, 100));
        expect(document.body.classList.contains('has-host-overlay-state')).toBe(false);

        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_OVERLAY_STATE', mode: 'popup', collapsed: false, draggable: true }
        }));
        expect(document.body.classList.contains('has-host-overlay-state')).toBe(true);
    });

    test('Collapse chrome does not pause or recreate audio', async () => {
        await new Promise(r => setTimeout(r, 100));
        const audio = document.getElementById('audio');
        audio.pause = jest.fn();
        Object.defineProperty(audio, 'paused', { value: false, configurable: true });

        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_OVERLAY_STATE', mode: 'popup', collapsed: true, draggable: true }
        }));
        expect(document.body.classList.contains('collapsed')).toBe(true);
        expect(audio.pause).not.toHaveBeenCalled();
        expect(document.getElementById('audio')).toBe(audio);

        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_OVERLAY_STATE', mode: 'popup', collapsed: false, draggable: true }
        }));
        expect(document.body.classList.contains('collapsed')).toBe(false);
        expect(document.getElementById('audio')).toBe(audio);
    });

    test('reader pause message stops audio without closing the embedded player', () => {
        const audio = document.getElementById('audio');
        audio.pause = jest.fn();
        window.parent.postMessage.mockClear();
        window.dispatchEvent(new MessageEvent('message', {
            data: 'PAUSE_KOKORO_PLAYER', source: window.parent,
            origin: window.location.origin,
        }));
        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(document.getElementById('playPause').textContent).toBe('Play');
        expect(window.parent.postMessage).not.toHaveBeenCalledWith('CLOSE_KOKORO_PLAYER', '*');
    });

    test('Close keeps a late autoplay reload paused until user resumes or opens a new document', async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const audio = document.getElementById('audio');
        audio.pause = jest.fn();
        audio.play = jest.fn().mockResolvedValue();

        let releaseStorage;
        browser.storage.local.get.mockImplementationOnce(() =>
            new Promise(resolve => { releaseStorage = resolve; }));
        window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
        await Promise.resolve();
        expect(typeof releaseStorage).toBe('function');

        window.dispatchEvent(new MessageEvent('message', {
            data: 'PAUSE_KOKORO_PLAYER', source: window.parent,
            origin: window.location.origin,
        }));
        releaseStorage({
            pendingText: 'Delayed chapter',
            pendingContent: [{ type: 'text', content: 'Delayed chapter' }],
            pendingTitle: 'Delayed chapter', pendingAutoplay: true,
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(audio.pause).toHaveBeenCalled();
        expect(audio.play).not.toHaveBeenCalled();
        expect(document.getElementById('playPause').textContent).toBe('Play');

        browser.storage.local.get.mockResolvedValueOnce({
            pendingText: 'New document',
            pendingContent: [{ type: 'text', content: 'New document' }],
            pendingTitle: 'New document', pendingAutoplay: true,
        });
        window.dispatchEvent(new MessageEvent('message', {
            data: 'RESUME_READER_AUTOPLAY', source: window.parent,
            origin: window.location.origin,
        }));
        window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(audio.play).toHaveBeenCalledTimes(1);
    });

    test('opt-in reader requests the next chapter after the final spoken sentence', async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const previousUrl = window.location.pathname + window.location.search;
        try {
            window.history.replaceState({}, '', '/overlay.html?waitForData=true');
            const audio = document.getElementById('audio');
            audio.play = jest.fn().mockResolvedValue();
            browser.storage.local.get.mockResolvedValueOnce({
                pendingText: 'Current chapter',
                pendingContent: [{ type: 'text', content: 'Current chapter' }],
                pendingTitle: 'Chapter 1',
                pendingAutoplay: true,
                pendingContinuousReader: true,
                pendingReaderReloadRevision: 47,
            });
            window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            window.dispatchEvent(new MessageEvent('message', { data: 'NAV_NEXT' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            window.parent.postMessage.mockClear();
            audio.dispatchEvent(new Event('ended'));
            await new Promise(resolve => setTimeout(resolve, 75));
            expect(window.parent.postMessage).toHaveBeenCalledWith({
                type: 'KOKORO_READER_CHAPTER_ENDED', revision: 47,
            }, '*');
            expect(document.getElementById('status').textContent)
                .toBe('Loading next chapter...');

            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'KOKORO_READER_LAST_CHAPTER', revision: 47 },
                source: window.parent, origin: window.location.origin,
            }));
            expect(document.getElementById('status').textContent).toBe('Done');
        } finally {
            window.history.replaceState({}, '', previousUrl);
        }
    });

    test('explicit Play after Close notifies the reader that playback resumed', async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const previousUrl = window.location.pathname + window.location.search;
        try {
            window.history.replaceState({}, '', '/overlay.html?waitForData=true');
            browser.storage.local.get.mockResolvedValueOnce({
                pendingText: 'Still reading',
                pendingContent: [{ type: 'text', content: 'Still reading' }],
                pendingAutoplay: false,
                pendingContinuousReader: true,
                pendingReaderReloadRevision: 99,
            });
            window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            const audio = document.getElementById('audio');
            audio.play = jest.fn().mockResolvedValue();
            window.parent.postMessage.mockClear();
            window.dispatchEvent(new MessageEvent('message', {
                data: 'PAUSE_KOKORO_PLAYER', source: window.parent,
                origin: window.location.origin,
            }));
            document.getElementById('playPause').click();
            expect(window.parent.postMessage).toHaveBeenCalledWith({
                type: 'KOKORO_READER_RESUMED', revision: 99,
            }, '*');
            expect(audio.play).toHaveBeenCalledTimes(1);
        } finally {
            window.history.replaceState({}, '', previousUrl);
        }
    });

    test('continuous mode is off by default and Close cancels a delayed completion', async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const previousUrl = window.location.pathname + window.location.search;
        try {
            window.history.replaceState({}, '', '/overlay.html?waitForData=true');
            const audio = document.getElementById('audio');
            audio.play = jest.fn().mockResolvedValue();
            browser.storage.local.get.mockResolvedValueOnce({
                pendingText: 'Current chapter',
                pendingContent: [{ type: 'text', content: 'Current chapter' }],
                pendingAutoplay: true,
                pendingContinuousReader: true,
                pendingReaderReloadRevision: 73,
            });
            window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            window.dispatchEvent(new MessageEvent('message', { data: 'NAV_NEXT' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            window.parent.postMessage.mockClear();

            audio.dispatchEvent(new Event('ended'));
            window.dispatchEvent(new MessageEvent('message', {
                data: 'PAUSE_KOKORO_PLAYER', source: window.parent,
                origin: window.location.origin,
            }));
            await new Promise(resolve => setTimeout(resolve, 75));
            expect(window.parent.postMessage.mock.calls.some(([message]) =>
                message?.type === 'KOKORO_READER_CHAPTER_ENDED')).toBe(false);

            browser.storage.local.get.mockResolvedValueOnce({
                pendingText: 'No continuous setting',
                pendingContent: [{ type: 'text', content: 'No continuous setting' }],
                pendingAutoplay: true,
                pendingReaderReloadRevision: 74,
            });
            window.dispatchEvent(new MessageEvent('message', {
                data: 'RESUME_READER_AUTOPLAY', source: window.parent,
                origin: window.location.origin,
            }));
            window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            window.dispatchEvent(new MessageEvent('message', { data: 'NAV_NEXT' }));
            await new Promise(resolve => setTimeout(resolve, 0));
            window.parent.postMessage.mockClear();
            audio.dispatchEvent(new Event('ended'));
            await new Promise(resolve => setTimeout(resolve, 75));
            expect(window.parent.postMessage.mock.calls.some(([message]) =>
                message?.type === 'KOKORO_READER_CHAPTER_ENDED')).toBe(false);
            expect(document.getElementById('status').textContent).toBe('Done');
        } finally {
            window.history.replaceState({}, '', previousUrl);
        }
    });

    test('Close still posts CLOSE_KOKORO_PLAYER', async () => {
        await new Promise(r => setTimeout(r, 100));
        window.parent.postMessage.mockClear();
        document.getElementById('close').click();
        expect(window.parent.postMessage).toHaveBeenCalledWith('CLOSE_KOKORO_PLAYER', '*');
    });

    test('shows active backend badge from pendingTtsBackend (#194)', async () => {
        await new Promise(r => setTimeout(r, 50));
        browser.storage.local.get.mockResolvedValueOnce({
            pendingText: 'Hello world',
            pendingContent: [{ type: 'text', content: 'Hello world' }],
            pendingTitle: 'Article',
            pendingTtsBackend: 'mediapipe',
            pendingAutoplay: false,
        });
        window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
        await new Promise(r => setTimeout(r, 0));
        const badge = document.getElementById('backendBadge');
        expect(badge.hidden).toBe(false);
        expect(badge.textContent).toBe('MediaPipe');
    });

    test('ArrowLeft/ArrowRight navigate when overlay is focused (#194)', async () => {
        await new Promise(r => setTimeout(r, 100));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results.at(-1)?.value;
        // Initial navigate lands on sentence 0; Right must advance, Left must retreat.
        manager.getAudio.mockClear();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
        await new Promise(r => setTimeout(r, 0));
        expect(manager.getAudio).toHaveBeenCalledWith(1);
        expect(document.getElementById('status').textContent).toMatch(/sentence 2\//);
        manager.getAudio.mockClear();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', bubbles: true }));
        await new Promise(r => setTimeout(r, 0));
        expect(manager.getAudio).toHaveBeenCalledWith(0);
        expect(document.getElementById('status').textContent).toMatch(/sentence 1\//);
    });

    test('playback errors name the backend and point to recovery (#194)', async () => {
        await new Promise(r => setTimeout(r, 50));
        const { AudioManager } = require('../audio-manager.js');
        const manager = AudioManager.mock.results.at(-1)?.value;
        manager.getAudio.mockRejectedValueOnce(new Error('model missing'));
        browser.storage.local.get.mockResolvedValueOnce({
            pendingText: 'Hello world',
            pendingContent: [{ type: 'text', content: 'Hello world' }],
            pendingTitle: 'Article',
            pendingTtsBackend: 'onnx',
            pendingAutoplay: true,
        });
        window.dispatchEvent(new MessageEvent('message', { data: 'RELOAD_DATA' }));
        await new Promise(r => setTimeout(r, 20));
        expect(document.getElementById('backendBadge').textContent).toBe('ONNX');
        expect(document.getElementById('status').textContent).toMatch(/ONNX/);
        expect(document.getElementById('status').textContent).toMatch(/Test TTS backends/);
        expect(document.getElementById('retry').style.display).toBe('inline-flex');
    });
});
