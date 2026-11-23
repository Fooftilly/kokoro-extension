/**
 * @jest-environment jsdom
 *
 * Popup settings IA blocks (#194 item 2) and shortcuts cheat sheet (#194 item 4).
 */

const {
    loadPopupDom,
    createPopupModuleLoader,
    installDefaultPopupGlobals,
} = require('./popup-test-harness.js');

describe('popup settings IA + shortcuts (#194 2+4)', () => {
    let popup;
    let harness;

    async function flushAsync() {
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
    }

    afterEach(() => {
        harness.detachDocumentListeners();
    });

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        loadPopupDom();
        installDefaultPopupGlobals({
            commandsGetAll: () => ([
                { name: 'read-article', shortcut: 'Alt+A' },
                { name: 'nav-prev', shortcut: 'Alt+Comma' },
                { name: 'nav-next', shortcut: 'Alt+Period' },
                { name: 'close-overlay', shortcut: 'Ctrl+Shift+W' },
                { name: 'open-reader', shortcut: '' },
            ]),
        });
        harness = createPopupModuleLoader();
        popup = harness.loadPopupModule();
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
        const introEl = sheet.querySelector('#shortcutsIntro');
        const noteEl = sheet.querySelector('.shortcuts-chrome-note');
        expect(introEl).toBeTruthy();
        expect(noteEl).toBeTruthy();
        expect(sheet.contains(introEl)).toBe(true);
        expect(sheet.contains(noteEl)).toBe(true);
        expect(introEl.textContent).toMatch(/current.*browser bindings/i);
        expect(introEl.textContent).toMatch(/chrome:\/\/extensions\/shortcuts/);
        expect(introEl.textContent).toMatch(/Firefox Add-ons → Manage extension shortcuts/);
        expect(noteEl.textContent).toMatch(/Chrome ships Open Document with no suggested key/i);
        expect(noteEl.textContent).toMatch(/chrome:\/\/extensions\/shortcuts/);
        expect(noteEl.textContent).toMatch(/Firefox Add-ons → Manage extension shortcuts/);
        expect(sheet.querySelector('[data-command="read-article"]')).toBeTruthy();
        expect(sheet.querySelector('[data-command="open-reader"]')).toBeTruthy();
        const openHint = document.getElementById('openDocumentShortcutHint');
        expect(sheet.contains(openHint)).toBe(false);
        expect(openHint.textContent).toMatch(/Firefox suggests/i);
        expect(openHint.textContent).toMatch(/Chrome often has none/i);
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
        expect(document.getElementById('shortcutsIntro').textContent)
            .toMatch(/Firefox Add-ons → Manage extension shortcuts/);
        expect(document.querySelector('[data-command="open-reader"] [data-shortcut]').textContent)
            .toBe('Alt+M');
        expect(sheet.textContent).toMatch(/Firefox suggested/i);
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
