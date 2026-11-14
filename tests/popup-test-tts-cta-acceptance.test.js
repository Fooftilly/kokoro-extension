/** @jest-environment node */
/**
 * Contract for popup Test TTS backends CTA live acceptance (#61) —
 * distinct shape from dual-use-this-backend harness probes.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const workflow = path.join(
    root, '.github', 'workflows', 'live-browser-acceptance.yml');

describe('popup Test TTS CTA acceptance', () => {
    test('Chromium dual path opens popup CTA before dual comparison', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toContain('async function acceptPopupTestTtsCta');
        expect(source).toContain('popupTestTtsCtaAcceptance');
        expect(source).toContain("popup.goto('chrome-extension://' + extensionId + '/popup.html')");
        expect(source).toContain("locator('#openBenchmarkBtn').click()");
        expect(source).toContain('context.waitForEvent(\'page\'');
        expect(source).toContain('GPU not offered');
        expect(source).toContain('threeBackendCards');
        expect(source).toContain('openedBenchmarkViaCta');
        const ctaIdx = source.indexOf('async function acceptPopupTestTtsCta');
        const dualIdx = source.indexOf('async function acceptTwoBackendComparison');
        const callCta = source.indexOf('acceptPopupTestTtsCta(');
        const callDual = source.indexOf('acceptTwoBackendComparison(');
        expect(ctaIdx).toBeGreaterThan(0);
        expect(dualIdx).toBeGreaterThan(ctaIdx);
        expect(callCta).toBeGreaterThan(0);
        expect(callDual).toBeGreaterThan(callCta);
    });

    test('Firefox dual path opens popup CTA before dual comparison', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toContain('def accept_popup_test_tts_cta');
        expect(source).toContain('popupTestTtsCtaAcceptance');
        expect(source).toContain('accept_popup_test_tts_cta(driver, state["origin"])');
        expect(source).toMatch(
            /find_element\(\s*By\.ID,\s*["']openBenchmarkBtn["']\s*\)\.click\(\)/);
        expect(source).toContain('GPU not offered');
        expect(source).toContain('threeBackendCards');
        expect(source).toContain('openedBenchmarkViaCta');
        const ctaIdx = source.indexOf('def accept_popup_test_tts_cta');
        const dualIdx = source.indexOf('def accept_two_backend_comparison');
        const callCta = source.indexOf('accept_popup_test_tts_cta(');
        const callDual = source.indexOf('accept_two_backend_comparison(');
        expect(ctaIdx).toBeGreaterThan(0);
        expect(dualIdx).toBeGreaterThan(ctaIdx);
        expect(callCta).toBeGreaterThan(0);
        expect(callDual).toBeGreaterThan(callCta);
    });

    test('dual-comparison workflow scopes still exist for live dispatch', () => {
        const source = fs.readFileSync(workflow, 'utf8');
        expect(source).toContain('- chromium-dual-comparison');
        expect(source).toContain('- firefox-dual-comparison');
    });
});
