/**
 * @jest-environment jsdom
 *
 * Popup tablist a11y + light hierarchy (#194 items 9+10).
 */

const fs = require('fs');
const path = require('path');

function loadPopupDom() {
    const html = fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8');
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : html;
    document.body.querySelectorAll('script').forEach((s) => s.remove());
}

describe('popup tab a11y + hierarchy (#194 9+10)', () => {
    let popup;
    let documentListeners = [];

    function loadPopupModule() {
        const addListener = document.addEventListener;
        document.addEventListener = function (type, handler, options) {
            documentListeners.push({ type, handler, options });
            return addListener.call(this, type, handler, options);
        };
        try {
            return require('../popup.js');
        } finally {
            document.addEventListener = addListener;
        }
    }

    afterEach(() => {
        for (const { type, handler, options } of documentListeners) {
            document.removeEventListener(type, handler, options);
        }
        documentListeners = [];
    });

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        loadPopupDom();
        document.documentElement.classList.remove('dark-theme');

        global.browser = {
            storage: {
                sync: {
                    get: jest.fn(async (defaults) => ({
                        ...defaults,
                        apiUrl: 'http://127.0.0.1:8880/v1/',
                        voice: 'af_sarah',
                        mode: 'stream',
                        theme: 'light',
                    })),
                    set: jest.fn(async () => {}),
                },
                local: {
                    set: jest.fn(async () => {}),
                    get: jest.fn(async (defaults) => defaults),
                },
            },
            permissions: {
                contains: jest.fn(async () => true),
                request: jest.fn(async () => true),
            },
            runtime: {
                getManifest: jest.fn(() => ({ version: '1.4.0' })),
            },
            tabs: { create: jest.fn() },
            commands: {
                getAll: jest.fn(async () => []),
            },
        };
        global.localStorage = {
            getItem: jest.fn(),
            setItem: jest.fn(),
            removeItem: jest.fn(),
        };
        global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
        Object.assign(global, require('../api-client.js'));
        Object.assign(global, { KokoroLocalVoiceMixing: require('../local-voice-mixing.js') });
        Object.assign(global, { KokoroBackendDisclosure: require('../backend-disclosure.js') });
        popup = loadPopupModule();
    });

    test('settings tabs expose tablist / tab / tabpanel roles', () => {
        const list = document.querySelector('[role="tablist"]');
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        const general = document.getElementById('general');
        const normalization = document.getElementById('normalization');

        expect(list).toBeTruthy();
        expect(list.getAttribute('aria-label')).toMatch(/settings/i);
        expect(tabs).toHaveLength(2);
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
        expect(tabs[0].tabIndex).toBe(0);
        expect(tabs[1].getAttribute('aria-selected')).toBe('false');
        expect(tabs[1].tabIndex).toBe(-1);
        expect(general.getAttribute('role')).toBe('tabpanel');
        expect(general.hidden).toBe(false);
        expect(normalization.getAttribute('role')).toBe('tabpanel');
        expect(normalization.hidden).toBe(true);
        expect(document.querySelector('label[for="voiceSearch"]')).toBeTruthy();
        expect(document.getElementById('status').getAttribute('role')).toBe('status');
    });

    test('arrow keys move between tabs and update panels', () => {
        const [generalTab, normTab] = document.querySelectorAll('[role="tab"]');
        generalTab.focus();
        generalTab.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight', bubbles: true, cancelable: true,
        }));

        expect(normTab.getAttribute('aria-selected')).toBe('true');
        expect(normTab.tabIndex).toBe(0);
        expect(generalTab.getAttribute('aria-selected')).toBe('false');
        expect(document.getElementById('normalization').hidden).toBe(false);
        expect(document.getElementById('general').hidden).toBe(true);
        expect(document.getElementById('normalizationHeading')).toBeTruthy();

        normTab.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Home', bubbles: true, cancelable: true,
        }));
        expect(generalTab.getAttribute('aria-selected')).toBe('true');
        expect(document.getElementById('general').hidden).toBe(false);
    });

    test('theme toggle has an actionable aria-label that tracks theme', () => {
        const toggle = document.getElementById('theme-toggle');
        popup.syncThemeToggleLabel();
        expect(toggle.getAttribute('aria-label')).toMatch(/dark theme/i);

        document.documentElement.classList.add('dark-theme');
        popup.syncThemeToggleLabel();
        expect(toggle.getAttribute('aria-label')).toMatch(/light theme/i);
    });

    test('inactive tab hover tokens meet WCAG AA contrast in both themes', () => {
        const css = fs.readFileSync(path.join(__dirname, '../popup.css'), 'utf8');
        expect(css).toMatch(/\.tab:hover:not\(\.active\)\s*\{[^}]*background-color:\s*var\(--tab-hover-bg\)/s);
        expect(css).toMatch(/\.tab:hover:not\(\.active\)\s*\{[^}]*color:\s*var\(--tab-hover-text\)/s);

        function parsePair(block) {
            const bg = block.match(/--tab-hover-bg:\s*(#[0-9a-fA-F]{3,8})/);
            const fg = block.match(/--tab-hover-text:\s*(#[0-9a-fA-F]{3,8})/);
            expect(bg).toBeTruthy();
            expect(fg).toBeTruthy();
            return { bg: bg[1], fg: fg[1] };
        }

        function hexToRgb(hex) {
            const h = hex.length === 4
                ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
                : hex;
            return [
                parseInt(h.slice(1, 3), 16) / 255,
                parseInt(h.slice(3, 5), 16) / 255,
                parseInt(h.slice(5, 7), 16) / 255,
            ];
        }

        function luminance([r, g, b]) {
            const lin = [r, g, b].map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
            return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
        }

        function contrast(fg, bg) {
            const L1 = luminance(hexToRgb(fg));
            const L2 = luminance(hexToRgb(bg));
            const lighter = Math.max(L1, L2);
            const darker = Math.min(L1, L2);
            return (lighter + 0.05) / (darker + 0.05);
        }

        const root = parsePair(css.match(/:root\s*\{([\s\S]*?)\n\}/)[1]);
        const dark = parsePair(css.match(/\.dark-theme\s*\{([\s\S]*?)\n\}/)[1]);
        expect(contrast(root.fg, root.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark.fg, dark.bg)).toBeGreaterThanOrEqual(4.5);
    });
});
