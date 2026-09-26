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
        prefetch: jest.fn(),
        on: jest.fn()
    }))
}));

const mockSentences = [{ index: 0, text: 'Hello', html: 'Hello' }];
jest.mock('../text-processor.js', () => ({
    processContent: jest.fn(() => ({
        sentences: mockSentences,
        renderData: [{ type: 'paragraph', sentences: mockSentences }]
    }))
}));

// Mock scrollIntoView
Element.prototype.scrollIntoView = jest.fn();

function setupDOM() {
    document.body.className = '';
    document.body.innerHTML = `
        <div id="dragHandle">
            <span class="drag-grip">⋮⋮</span>
            <div id="pageTitle">Kokoro TTS</div>
        </div>
        <button id="collapse" aria-label="Collapse player">–</button>
        <button id="close">×</button>
        <div id="progressBar"></div>
        <div id="timeEstimate"></div>
        <div id="loadingSpinner"></div>
        <div id="status">Ready</div>
        <div id="text-display"></div>
        <audio id="audio"></audio>
        <button id="playPause">Pause</button>
        <button id="seekBack">Prev</button>
        <button id="seekFwd">Next</button>
        <input type="range" id="volumeControl" value="1">
        <button id="retry"></button>
        <select id="speed">
            <option value="1.0">1.0x</option>
        </select>
    `;
}

describe('overlay.js logic', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        setupDOM();
        // Require the script AFTER DOM is setup
        require('../overlay.js');
    });

    test('Initializes correctly', async () => {
        await new Promise(r => setTimeout(r, 100)); // Wait for async init
        const textDisplay = document.getElementById('text-display');
        expect(textDisplay.textContent).toContain('Hello');
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

    test('Close still posts CLOSE_KOKORO_PLAYER', async () => {
        await new Promise(r => setTimeout(r, 100));
        window.parent.postMessage.mockClear();
        document.getElementById('close').click();
        expect(window.parent.postMessage).toHaveBeenCalledWith('CLOSE_KOKORO_PLAYER', '*');
    });
});
