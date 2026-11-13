/**
 * @jest-environment jsdom
 *
 * Covers showFloatingButton false→true restore while the page selection is unchanged.
 */

describe('floating mic setting toggle (#11 P3)', () => {
    let storageChangeListener;
    let showFloatingButtonValue;
    let focusRectSpy;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers({ doNotFake: [] });
        document.body.innerHTML = '';
        delete window.kokoroContentInjected;
        storageChangeListener = null;
        showFloatingButtonValue = true;

        global.Readability = jest.fn();
        require('../overlay-position.js');
        require('../floating-mic-position.js');

        // jsdom caret geometry is unreliable; stub focus rect for this interaction test.
        focusRectSpy = jest.spyOn(globalThis.KokoroFloatingMicPosition, 'getSelectionFocusClientRect')
            .mockReturnValue({
                top: 40, left: 120, bottom: 56, right: 120, width: 0, height: 16
            });

        global.browser = {
            runtime: {
                onMessage: { addListener: jest.fn() },
                getURL: jest.fn((p) => `chrome-extension://kokoro-test/${p}`),
                sendMessage: jest.fn(() => Promise.resolve())
            },
            storage: {
                sync: {
                    get: jest.fn(() => Promise.resolve({
                        showFloatingButton: showFloatingButtonValue
                    }))
                },
                local: {
                    get: jest.fn(() => Promise.resolve({})),
                    set: jest.fn(() => Promise.resolve())
                },
                onChanged: {
                    addListener: jest.fn((listener) => {
                        storageChangeListener = listener;
                    })
                }
            }
        };

        require('../content.js');
        expect(storageChangeListener).toEqual(expect.any(Function));
    });

    afterEach(() => {
        if (focusRectSpy) focusRectSpy.mockRestore();
        jest.useRealTimers();
        delete window.kokoroContentInjected;
    });

    function selectParagraphText() {
        const p = document.createElement('p');
        p.textContent = 'Selectable floating mic sentence.';
        document.body.appendChild(p);
        const textNode = p.firstChild;
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.setBaseAndExtent(textNode, 0, textNode, textNode.textContent.length);
        return selection.toString();
    }

    async function flushAsyncWork() {
        // Drain microtasks from async handleSelection / storage.get
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
        }
        jest.runOnlyPendingTimers();
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
        }
        jest.runOnlyPendingTimers();
    }

    test('false→true restores mic without changing the existing selection', async () => {
        const selected = selectParagraphText();
        expect(selected.length).toBeGreaterThan(0);

        // Establish visible mic via selectionchange throttle path
        document.dispatchEvent(new Event('selectionchange'));
        jest.advanceTimersByTime(120);
        await flushAsyncWork();

        const btn = document.getElementById('kokoro-float-btn');
        expect(btn).toBeTruthy();
        expect(btn.style.display).not.toBe('none');
        expect(btn.style.opacity).toBe('1');

        const beforeText = window.getSelection().toString();

        // Disable while selection remains
        showFloatingButtonValue = false;
        storageChangeListener({
            showFloatingButton: { oldValue: true, newValue: false }
        }, 'sync');
        await flushAsyncWork();
        expect(btn.style.opacity).toBe('0');
        expect(window.getSelection().toString()).toBe(beforeText);

        // Re-enable without touching the selection
        showFloatingButtonValue = true;
        storageChangeListener({
            showFloatingButton: { oldValue: false, newValue: true }
        }, 'sync');
        await flushAsyncWork();

        expect(window.getSelection().toString()).toBe(beforeText);
        const restored = document.getElementById('kokoro-float-btn');
        expect(restored).toBeTruthy();
        expect(restored.style.display).toBe('flex');
        expect(restored.style.opacity).toBe('1');
    });
});
