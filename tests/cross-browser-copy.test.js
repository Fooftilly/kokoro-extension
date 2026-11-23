/**
 * #194 item 11 — Chrome vs Firefox copy where behavior truly differs.
 */

const fs = require('fs');
const path = require('path');

describe('cross-browser Chrome vs Firefox copy (#194 item 11)', () => {
    const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
    const popupHtml = fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8');

    test('README documents Open Document Chrome gap and both shortcut pages', () => {
        expect(readme).toMatch(/four suggested (shortcut )?keys/i);
        expect(readme).toMatch(/chrome:\/\/extensions\/shortcuts/);
        expect(readme).toMatch(/Add-ons → Manage extension shortcuts/);
        expect(readme).toMatch(/Firefox also suggests Alt\+M for Open Document/i);
        expect(readme).toMatch(/in-player keys on both browsers/i);
    });

    test('popup Open Document hint and cheat sheet cover both browsers', () => {
        expect(popupHtml).toMatch(/id="openDocumentShortcutHint"/);
        expect(popupHtml).toMatch(/Firefox suggests[\s\S]*Alt\+M/i);
        expect(popupHtml).toMatch(/Chrome often has none/i);
        expect(popupHtml).toMatch(/four-key limit/i);
        expect(popupHtml).toMatch(/chrome:\/\/extensions\/shortcuts/);
        expect(popupHtml).toMatch(/Firefox Add-ons → Manage extension shortcuts/);
    });
});
