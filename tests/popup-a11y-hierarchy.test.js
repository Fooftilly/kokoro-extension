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
});
