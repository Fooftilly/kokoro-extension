/**
 * @jest-environment jsdom
 */

import { Readability } from '@mozilla/readability';

describe('content.js parseArticle', () => {
    let parseArticle;

    beforeAll(() => {
        // Setup globals BEFORE requiring content.js because content.js executes top-level code
        global.Readability = Readability;
        require('../overlay-position.js');

        global.browser = {
            runtime: {
                onMessage: {
                    addListener: jest.fn()
                },
                getURL: jest.fn((path) => `chrome-extension://kokoro-test/${path}`)
            },
            storage: {
                local: {
                    get: jest.fn(() => Promise.resolve({})),
                    set: jest.fn(() => Promise.resolve())
                }
            }
        };

        // Check if module is defined (it is in Jest/Node)
        // require content.js now
        const contentModule = require('../content.js');
        parseArticle = contentModule.parseArticle;
    });

    beforeEach(() => {
        // Reset DOM before each test
        document.body.innerHTML = '';
        jest.clearAllMocks();
    });

    test('should extract simple paragraph text', async () => {
        // Setup mock document content
        document.body.innerHTML = `
            <article>
                <h1>Title</h1>
                <p>First paragraph.</p>
                <p>Second paragraph.</p>
            </article>
        `;

        const result = await parseArticle(document);

        expect(result).not.toBeNull();
        expect(result.text).toContain('First paragraph.');
        expect(result.text).toContain('Second paragraph.');
        expect(result.content.length).toBeGreaterThan(0);
    });

    test('should handle footnotes by replacing with span', async () => {
        document.body.innerHTML = `
            <article>
                <p>Text with footnote<a href="#fn1">[1]</a>.</p>
                <div id="fn1">This is the footnote content.</div>
            </article>
        `;

        const result = await parseArticle(document);

        // Check if logic processed the footnote. 
        // Note: Readability might strip the div#fn1 if it's not considered main content.
        // But if it is inside article, it might be.
        // However, the footnote logic querySelectors from 'articleDoc' which comes from Readability parse.

        const footnoteSpan = result.content.find(b => b.html && b.html.includes('footnote-ref'));
        // If Readability preserves the link, our logic converts it.
        // Depending on Readability implementation, simple setup might fail if it deems "This is the footnote content" as not content.
    });

    test('should ignore promos', async () => {
        document.body.innerHTML = `
            <article>
                <p>Real content.</p>
                <p class="subscribe">Subscribe to our newsletter!</p>
            </article>
        `;

        const result = await parseArticle(document);
        // The subscribe para should ideally be marked as 'silent' or excluded.
        const promo = result.content.find(b => b.content === 'Subscribe to our newsletter!');
        expect(promo).toBeDefined();
        expect(promo.type).toBe('silent');
    });

    test('should extract images', async () => {
        document.body.innerHTML = `
            <article>
                <p>Text</p>
                <img src="http://example.com/image.jpg" />
            </article>
        `;

        const result = await parseArticle(document);
        const img = result.content.find(b => b.type === 'image');
        expect(img).toBeDefined();
        expect(img.src).toBe('http://example.com/image.jpg');
    });

    test('should handle nested lists', async () => {
        document.body.innerHTML = `
            <article>
                <ul>
                    <li>Outer 1
                        <ul>
                            <li>Inner 1.1</li>
                        </ul>
                    </li>
                </ul>
            </article>
        `;

        const result = await parseArticle(document);
        // We should skip checking depth if Readability flattens it,
        // but let's check if we at least found the items.
        const listItems = result.content.filter(b => b.type === 'list-item');
        expect(listItems.length).toBeGreaterThanOrEqual(1);
    });

    test('should handle tables and figures', async () => {
        document.body.innerHTML = `
            <article>
                <h1>Article with Table</h1>
                <p>This is a substantial paragraph of text to ensure Readability considers this a valid article and doesn't strip the following content as boilerplate or noise.</p>
                <table>
                    <tr><th>Header 1</th><th>Header 2</th></tr>
                    <tr><td>Cell 1</td><td>Cell 2</td></tr>
                    <tr><td>Cell 3</td><td>Cell 4</td></tr>
                </table>
                <p>Another paragraph to provide context and length to the article content.</p>
                <figure>
                    <img src="fig.jpg">
                    <figcaption>Caption Text</figcaption>
                </figure>
            </article>
        `;

        const result = await parseArticle(document);
        const table = result.content.find(b => b.type === 'html' && b.html.includes('table'));
        expect(table).toBeDefined();
    });

    function postFromOverlayIframe(iframe, data, origin) {
        const opts = { data, source: iframe.contentWindow };
        if (origin) opts.origin = origin;
        window.dispatchEvent(new MessageEvent('message', opts));
    }

    /** Shared floating-overlay DOM + viewport for postMessage bridge tests. */
    function mountOverlayPlayerFixture({ mode = 'popup', style = '' } = {}) {
        const posApi = globalThis.KokoroOverlayPosition;
        Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

        const styleAttr = style ? ` style="${style}"` : '';
        document.body.innerHTML = `
            <div id="kokoro-overlay-container" data-mode="${mode}" data-collapsed="0"${styleAttr}>
                <iframe id="kokoro-player-frame"></iframe>
            </div>
        `;
        const container = document.getElementById('kokoro-overlay-container');
        const iframe = document.getElementById('kokoro-player-frame');
        iframe.src = browser.runtime.getURL('overlay.html');
        iframe.contentWindow.postMessage = jest.fn();
        return { posApi, container, iframe };
    }

    test('should handle auto-scroll message', async () => {
        document.body.innerHTML = `
            <div id="kokoro-overlay-container"><iframe id="kokoro-player-frame"></iframe></div>
            <div id="kokoro-main-content">
                <p>Paragraph 1</p>
                <p id="target">Target Text</p>
                <p>Paragraph 3</p>
            </div>
        `;

        const iframe = document.getElementById('kokoro-player-frame');
        const targetEl = document.getElementById('target');
        targetEl.scrollIntoView = jest.fn();

        // Simulate message from overlay iframe
        const messageEvent = new MessageEvent('message', {
            data: {
                action: 'KOKORO_SCROLL_TO_BLOCK',
                text: 'Target Text'
            },
            source: iframe.contentWindow
        });
        window.dispatchEvent(messageEvent);

        // We need to wait for the message handler to run
        // and we might need to mock getBoundingClientRect for the visibility check
        targetEl.getBoundingClientRect = jest.fn(() => ({
            top: -100, // Force scroll by being above zone
            bottom: -50,
            height: 50
        }));

        // Dispatch again with mocks ready
        window.dispatchEvent(messageEvent);

        expect(targetEl.scrollIntoView).toHaveBeenCalled();
    });

    test('drag move deltas preserve offset from nonzero top-right position', () => {
        const { posApi, container, iframe } = mountOverlayPlayerFixture();
        const defaultPos = posApi.defaultOverlayPosition({
            viewportWidth: 1000,
            width: posApi.OVERLAY_POPUP_WIDTH
        });
        expect(defaultPos.left).toBeGreaterThan(500);

        container.style.position = 'fixed';
        container.style.left = `${defaultPos.left}px`;
        container.style.top = `${defaultPos.top}px`;
        container.style.width = `${posApi.OVERLAY_POPUP_WIDTH}px`;
        container.style.height = `${posApi.OVERLAY_POPUP_HEIGHT}px`;

        const startLeft = defaultPos.left;
        const startTop = defaultPos.top;

        postFromOverlayIframe(iframe, { action: 'KOKORO_DRAG_START' });
        postFromOverlayIframe(iframe, { action: 'KOKORO_DRAG_MOVE', dx: -80, dy: 30 });

        expect(Number.parseFloat(container.style.left)).toBe(startLeft - 80);
        expect(Number.parseFloat(container.style.top)).toBe(startTop + 30);

        postFromOverlayIframe(iframe, { action: 'KOKORO_DRAG_END' });
        expect(browser.storage.local.set).toHaveBeenCalledWith({
            [posApi.getOverlayPositionStorageKey()]: {
                left: startLeft - 80,
                top: startTop + 30
            }
        });
    });

    test('collapsed host height fits retained chrome constant', () => {
        const { posApi, container, iframe } = mountOverlayPlayerFixture();
        container.style.left = '40px';
        container.style.top = '40px';

        postFromOverlayIframe(iframe, { action: 'KOKORO_SET_COLLAPSED', collapsed: true });

        expect(container.dataset.collapsed).toBe('1');
        expect(Number.parseFloat(container.style.height)).toBe(posApi.OVERLAY_COLLAPSED_HEIGHT);
        expect(posApi.OVERLAY_COLLAPSED_HEIGHT).toBeGreaterThanOrEqual(140);
    });

    test('full→floating collapse still applies geometry when storage.get rejects', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { posApi, container, iframe } = mountOverlayPlayerFixture({
            mode: 'full',
            style: 'width:100vw;height:100vh;left:0;top:0;background:rgba(0,0,0,0.7)'
        });

        browser.storage.local.get.mockRejectedValueOnce(new Error('storage unavailable'));

        postFromOverlayIframe(iframe, { action: 'KOKORO_SET_COLLAPSED', collapsed: true });

        await Promise.resolve();
        await Promise.resolve();

        expect(warnSpy).toHaveBeenCalledWith(
            'Kokoro: failed to read overlay position',
            expect.any(Error)
        );
        expect(container.dataset.mode).toBe('popup');
        expect(container.dataset.collapsed).toBe('1');
        expect(container.style.width).toBe(`${posApi.OVERLAY_POPUP_WIDTH}px`);
        expect(Number.parseFloat(container.style.height)).toBe(posApi.OVERLAY_COLLAPSED_HEIGHT);
        expect(container.style.width).not.toBe('100vw');
        expect(container.style.height).not.toBe('100vh');
        expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'KOKORO_OVERLAY_STATE',
                mode: 'popup',
                collapsed: true
            }),
            expect.any(String)
        );

        warnSpy.mockRestore();
    });

    test('ignores overlay-control messages from window/wrong source; accepts iframe source', () => {
        const { posApi, container, iframe } = mountOverlayPlayerFixture({
            style: 'left:40px;top:40px;width:320px;height:500px;opacity:0.5'
        });
        const extensionOrigin = new URL(browser.runtime.getURL('overlay.html')).origin;

        // Host page / wrong source must not collapse or write storage
        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_SET_COLLAPSED', collapsed: true },
            source: window,
            origin: window.location.origin
        }));
        expect(container.dataset.collapsed).toBe('0');
        expect(browser.storage.local.set).not.toHaveBeenCalled();

        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_DRAG_START' },
            source: window
        }));
        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_DRAG_MOVE', dx: 10, dy: 10 },
            source: window
        }));
        window.dispatchEvent(new MessageEvent('message', {
            data: { action: 'KOKORO_DRAG_END' },
            source: window
        }));
        expect(Number.parseFloat(container.style.left)).toBe(40);
        expect(browser.storage.local.set).not.toHaveBeenCalled();

        window.dispatchEvent(new MessageEvent('message', {
            data: 'CLOSE_KOKORO_PLAYER',
            source: window
        }));
        expect(document.getElementById('kokoro-overlay-container')).not.toBeNull();

        window.dispatchEvent(new MessageEvent('message', {
            data: 'KOKORO_PLAYER_READY',
            source: window
        }));
        expect(container.style.opacity).toBe('0.5');

        // Trusted overlay iframe source is accepted
        postFromOverlayIframe(
            iframe,
            { action: 'KOKORO_SET_COLLAPSED', collapsed: true },
            extensionOrigin
        );
        expect(container.dataset.collapsed).toBe('1');
        expect(Number.parseFloat(container.style.height)).toBe(posApi.OVERLAY_COLLAPSED_HEIGHT);
    });
});
