/**
 * @jest-environment jsdom
 *
 * Popup settings IA blocks (#194 item 2) and shortcuts cheat sheet (#194 item 4).
 */

const fs = require('fs');
const path = require('path');

function loadPopupDom() {
    const html = fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8');
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : html;
    document.body.querySelectorAll('script').forEach((s) => s.remove());
}

describe('popup settings IA + shortcuts (#194 2+4)', () => {
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

    async function flushAsync() {
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
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
                getAll: jest.fn(async () => ([
                    { name: 'read-article', shortcut: 'Alt+A' },
                    { name: 'nav-prev', shortcut: 'Alt+Comma' },
                    { name: 'nav-next', shortcut: 'Alt+Period' },
                    { name: 'close-overlay', shortcut: 'Ctrl+Shift+W' },
                    { name: 'open-reader', shortcut: '' },
                ])),
            },
        };
        global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
        global.localStorage = {
            getItem: jest.fn(),
            setItem: jest.fn(),
            removeItem: jest.fn(),
        };
        Object.assign(global, require('../api-client.js'));
        Object.assign(global, { KokoroLocalVoiceMixing: require('../local-voice-mixing.js') });
        Object.assign(global, { KokoroBackendDisclosure: require('../backend-disclosure.js') });
        popup = loadPopupModule();
    });

    test('General tab lists How you listen → Voice → Playback → Page & reader', () => {
        const general = document.getElementById('general');
        const headings = [...general.querySelectorAll('.section-heading')]
            .map((el) => el.textContent.trim());
        expect(headings).toEqual([
            'How you listen',
            'Voice',
            'Playback defaults',
            'Page & reader',
        ]);

        const how = document.getElementById('howListenHeading').closest('.settings-block');
        const voice = document.getElementById('voiceHeading').closest('.settings-block');
        const playback = document.getElementById('playbackHeading').closest('.settings-block');
        const page = document.getElementById('pageReaderHeading').closest('.settings-block');

        expect(how.contains(document.getElementById('serverSettings'))).toBe(true);
        expect(how.contains(document.getElementById('localSetupBanner'))).toBe(true);
        expect(voice.contains(document.getElementById('voiceMixerContainer'))).toBe(true);
        expect(playback.contains(document.getElementById('defaultSpeed'))).toBe(true);
        expect(playback.contains(document.getElementById('playbackModeSection'))).toBe(true);
        expect(page.contains(document.getElementById('showFloatingButton'))).toBe(true);
        expect(page.contains(document.getElementById('autoplayReader'))).toBe(true);
        expect(page.contains(document.getElementById('playbackModeSection'))).toBe(false);
    });

    test('shortcuts cheat sheet documents Chrome Open Document note', () => {
        const sheet = document.getElementById('shortcutsCheatSheet');
        expect(sheet).toBeTruthy();
        expect(sheet.tagName).toBe('DETAILS');
        expect(sheet.open).toBe(false);
        const text = sheet.textContent;
        expect(text).toMatch(/current.*browser bindings/i);
        expect(text).toMatch(/Chrome ships Open Document with no suggested key/i);
        expect(text).toMatch(/chrome:\/\/extensions\/shortcuts/);
        expect(sheet.querySelector('[data-command="read-article"]')).toBeTruthy();
        expect(sheet.querySelector('[data-command="open-reader"]')).toBeTruthy();
    });

    test('formatCommandShortcut normalizes API shortcut names', () => {
        expect(popup.formatCommandShortcut('Alt+Comma')).toBe('Alt+,');
        expect(popup.formatCommandShortcut('Alt+Period')).toBe('Alt+.');
        expect(popup.formatCommandShortcut('Command+Shift+7')).toBe('Command+Shift+7');
        expect(popup.formatCommandShortcut('')).toBe('Not set');
        expect(popup.formatCommandShortcut(null)).toBe('Not set');
    });

    test('marks install defaults when commands.getAll is unavailable', async () => {
        delete global.browser.commands;
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        const sheet = document.getElementById('shortcutsCheatSheet');
        expect(sheet.getAttribute('data-shortcuts-source')).toBe('fallback');
        expect(document.getElementById('shortcutsIntro').textContent)
            .toMatch(/Could not read current bindings/i);
    });

    test('cheat sheet uses live browser.commands bindings after reassignment', async () => {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        expect(browser.commands.getAll).toHaveBeenCalled();
        const byCommand = (name) => document
            .querySelector(`[data-command="${name}"] [data-shortcut]`).textContent;
        expect(byCommand('read-article')).toBe('Alt+A');
        expect(byCommand('nav-prev')).toBe('Alt+,');
        expect(byCommand('nav-next')).toBe('Alt+.');
        // Reassigned away from the Alt+W install default.
        expect(byCommand('close-overlay')).toBe('Ctrl+Shift+W');
        expect(byCommand('open-reader')).toBe('Not set');
    });
});
