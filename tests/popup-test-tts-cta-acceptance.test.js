/** @jest-environment node */
/**
 * Contract for popup Test TTS backends CTA (#61) — shape distinct from
 * dual-use-this-backend-acceptance.test.js (Sonar new-code duplication).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'popup-test-tts-cta-acceptance.mjs')).href;
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as cta from ${JSON.stringify(helperUrl)};
const ok = cta.assertPopupTestTtsSurface({
    cta: cta.POPUP_CTA_LABEL,
    hint: 'Confirm with Use this backend on the test page.',
    cardCount: 3,
    cards: [
        { value: 'fastapi', title: 'server', meta: 'default' },
        { value: 'mediapipe', title: 'mp', meta: 'CPU/WASM · GPU not offered' },
        { value: 'onnx', title: 'onnx', meta: 'WASM CPU' },
    ],
    mediapipeMeta: 'CPU/WASM · GPU not offered',
});
const report = cta.buildPopupCtaAcceptanceReport({
    browser: 'chromium', benchmarkUrl: 'chrome-extension://x/benchmark.html',
});
const fail = (() => {
    try {
        cta.assertPopupTestTtsSurface({ cta: 'wrong', hint: '', cards: [] });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    label: cta.POPUP_CTA_LABEL,
    values: [...cta.EXPECTED_BACKEND_CARD_VALUES],
    ok, report, fail,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('popup Test TTS CTA acceptance', () => {
    test('shared helper validates surface and builds report', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.label).toBe('Test TTS backends');
        expect(snap.values).toEqual(['fastapi', 'mediapipe', 'onnx']); // catalog order
        expect(snap.ok).toBe(true);
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            threeBackendCards: true,
            gpuNotOfferedDisclosed: true,
            openedBenchmarkViaCta: true,
        }));
        expect(snap.fail.ok).toBe(false);
        expect(snap.fail.message).toMatch(/CTA label mismatch/i);
    });

    test('Chromium and Firefox dual scopes wire popup CTA before dual', () => {
        const chromium = fs.readFileSync(chromiumLive, 'utf8');
        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        expect(chromium).toContain('popup-test-tts-cta-acceptance.mjs');
        expect(chromium).toContain("locator('#openBenchmarkBtn').click()");
        expect(firefox).toContain('firefox_popup_test_tts_cta_acceptance');
        expect(firefox).toMatch(
            /find_element\(\s*By\.ID,\s*["']openBenchmarkBtn["']\s*\)\.click\(\)/);
        // Match await/assignment call sites — not `async function` / `def` decls.
        const chromiumCtaCall = chromium.indexOf('await acceptPopupTestTtsCta(');
        const chromiumDualCall = chromium.indexOf(
            'await acceptTwoBackendComparison(');
        expect(chromiumCtaCall).toBeGreaterThan(0);
        expect(chromiumDualCall).toBeGreaterThan(chromiumCtaCall);
        const firefoxCtaCall = firefox.indexOf(
            'accept_popup_test_tts_cta(driver, state["origin"])');
        const firefoxDualCall = firefox.indexOf(
            'accept_two_backend_comparison(driver, state["origin"])');
        expect(firefoxCtaCall).toBeGreaterThan(0);
        expect(firefoxDualCall).toBeGreaterThan(firefoxCtaCall);
    });
});

