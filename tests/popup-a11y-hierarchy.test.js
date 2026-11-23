/**
 * @jest-environment jsdom
 *
 * Popup tablist a11y + light hierarchy (#194 items 9+10).
 */

const fs = require('fs');
const path = require('path');
const { contrastRatio, cssVar } = require('./contrast-helpers.js');
const {
    loadPopupDom,
    createPopupModuleLoader,
    installDefaultPopupGlobals,
} = require('./popup-test-harness.js');

describe('popup tab a11y + hierarchy (#194 9+10)', () => {
    let popup;
    let harness;

    afterEach(() => {
        harness.detachDocumentListeners();
    });

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        loadPopupDom();
        document.documentElement.classList.remove('dark-theme');
        installDefaultPopupGlobals();
        harness = createPopupModuleLoader();
        popup = harness.loadPopupModule();
    });

    test('settings tabs expose tablist / tab / tabpanel roles', () => {
        const list = document.querySelector('[role="tablist"]');
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        const theme = document.getElementById('theme-toggle');
        const general = document.getElementById('general');
        const normalization = document.getElementById('normalization');

        expect(list).toBeTruthy();
        expect(list.getAttribute('aria-label')).toMatch(/settings/i);
        expect(tabs).toHaveLength(2);
        expect(list.contains(theme)).toBe(false);
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
        expect(tabs[0].tabIndex).toBe(0);
        expect(tabs[1].getAttribute('aria-selected')).toBe('false');
        expect(tabs[1].tabIndex).toBe(-1);
        expect(general.getAttribute('role')).toBe('tabpanel');
        expect(general.hidden).toBe(false);
        expect(normalization.getAttribute('role')).toBe('tabpanel');
        expect(normalization.hidden).toBe(true);
        expect(document.getElementById('voiceSearch').getAttribute('aria-label')).toMatch(/search/i);
        expect(document.getElementById('statusLive').getAttribute('role')).toBe('status');
        expect(document.getElementById('status').getAttribute('aria-hidden')).toBe('true');
    });

    test('arrow keys move focus and selection between tabs', () => {
        const [generalTab, normTab] = document.querySelectorAll('[role="tab"]');
        generalTab.focus();
        generalTab.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight', bubbles: true, cancelable: true,
        }));

        expect(document.activeElement).toBe(normTab);
        expect(normTab.getAttribute('aria-selected')).toBe('true');
        expect(normTab.tabIndex).toBe(0);
        expect(generalTab.getAttribute('aria-selected')).toBe('false');
        expect(document.getElementById('normalization').hidden).toBe(false);
        expect(document.getElementById('general').hidden).toBe(true);
        expect(document.getElementById('normalizationHeading')).toBeTruthy();

        normTab.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Home', bubbles: true, cancelable: true,
        }));
        expect(document.activeElement).toBe(generalTab);
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

        const lightFg = cssVar(css, ':root', 'tab-hover-text');
        const lightBg = cssVar(css, ':root', 'tab-hover-bg');
        const darkFg = cssVar(css, '.dark-theme', 'tab-hover-text');
        const darkBg = cssVar(css, '.dark-theme', 'tab-hover-bg');
        expect(contrastRatio(lightFg, lightBg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(darkFg, darkBg)).toBeGreaterThanOrEqual(4.5);
    });

    test('save toast announces via always-present live region', () => {
        const live = document.getElementById('statusLive');
        expect(live.textContent).toBe('');
        popup.showSaveStatusToast(null, 'fastapi');
        expect(live.textContent).toBe('Settings saved.');
        expect(document.getElementById('status').textContent).toBe('Settings saved.');
        expect(document.getElementById('status').style.display).toBe('block');
    });

    test('missing backend save error announces via live region', async () => {
        document.getElementById('modeStream').checked = true;
        document.querySelectorAll('input[name="ttsBackend"]').forEach((el) => {
            el.checked = false;
        });
        const result = await popup.saveOptions(false);
        expect(result).toEqual({ ok: false, error: true });
        expect(document.getElementById('statusLive').textContent).toMatch(
            /Choose a valid TTS backend/i
        );
        expect(document.getElementById('status').textContent).toMatch(
            /Choose a valid TTS backend/i
        );
    });

    test('storage write failure announces via live region', async () => {
        document.getElementById('modeStream').checked = true;
        document.querySelector('input[name="ttsBackend"][value="fastapi"]').checked = true;
        global.LocalVoice = {
            normalizeLocalVoiceId: (id) => id || 'af_heart',
            normalizeOnnxVoiceAsset: (v) => v || 'voices/af.bin',
            ONNX_FIXED_VOICE_ASSET: 'voices/af.bin',
        };
        jest.spyOn(console, 'error').mockImplementation(() => {});
        browser.storage.sync.set.mockRejectedValueOnce(
            new Error('QUOTA_BYTES_PER_ITEM quota exceeded')
        );
        const result = await popup.saveOptions(false);
        expect(result).toEqual({ ok: false, error: true });
        expect(document.getElementById('statusLive').textContent).toMatch(
            /QUOTA_BYTES_PER_ITEM/i
        );
        expect(document.getElementById('status').textContent).toMatch(
            /QUOTA_BYTES_PER_ITEM/i
        );
    });
});
