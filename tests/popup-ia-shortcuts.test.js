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
    beforeEach(() => {
        loadPopupDom();
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

        // Stream/Download stays with playback defaults, not page/reader toggles.
        expect(page.contains(document.getElementById('playbackModeSection'))).toBe(false);
    });

    test('shortcuts cheat sheet lists commands and Chrome Open Document note', () => {
        const sheet = document.getElementById('shortcutsCheatSheet');
        expect(sheet).toBeTruthy();
        expect(sheet.tagName).toBe('DETAILS');
        expect(sheet.open).toBe(false);

        const text = sheet.textContent;
        expect(text).toMatch(/Alt.*A.*Read article/i);
        expect(text).toMatch(/Alt.*,.*Previous sentence/i);
        expect(text).toMatch(/Alt.*\..*Next sentence/i);
        expect(text).toMatch(/Alt.*W.*Close overlay/i);
        expect(text).toMatch(/Alt.*M.*Open Document/i);
        expect(text).toMatch(/Firefox/i);
        expect(text).toMatch(/Chrome does not assign a default Open Document/i);
        expect(text).toMatch(/chrome:\/\/extensions\/shortcuts/);
    });
});
