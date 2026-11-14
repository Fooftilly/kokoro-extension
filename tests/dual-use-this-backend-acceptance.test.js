/** @jest-environment node */
/**
 * Contract for dual-comparison Use this backend (#61) — keep shape distinct
 * from long-form / article selection harness probes (Sonar new-code duplication).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const workflow = path.join(
    root, '.github', 'workflows', 'live-browser-acceptance.yml');

/** Require the choose selector appears in a `.click()` call site so a bare
 *  unused string declaration cannot satisfy the contract. */
function expectChooseClick(source, variant, style) {
    const selector = `[data-variant="${variant}"] .model-choose`;
    expect(source).toContain(selector);
    if (style === 'chromium') {
        const re = new RegExp(
            String.raw`locator\(\s*['\`][^'\`]*` +
                selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                String.raw`[^'\`]*['\`]\s*\)\.click\(\)`);
        expect(re.test(source)).toBe(true);
        return;
    }
    // Firefox may split find_element(...).click() across lines.
    const re = new RegExp(
        String.raw`find_element\(\s*By\.CSS_SELECTOR,\s*['"]` +
            selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            String.raw`['"]\s*\)\s*\.click\(\)`,
        's');
    expect(re.test(source)).toBe(true);
}

describe('dual Use this backend acceptance', () => {
    test('Chromium dual comparison clicks Use this backend after measure', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toContain('async function acceptTwoBackendComparison');
        expect(source).toContain('providerFilter === \'both\' && !originDownload');
        expectChooseClick(source, 'onnx-q8', 'chromium');
        expectChooseClick(source, 'mediapipe-cpu', 'chromium');
        expect(source).toContain('useThisBackend');
        expect(source).toContain('preferenceOnlyOnChoose');
        expect(source).toContain('backendSelectionUnchangedDuringMeasure');
        expect(source).not.toMatch(
            /\bbackendSelectionUnchanged:\s*true\b/);
        expect(source).toContain(
            'ONNX q8 selected for dictionary-supported English');
        expect(source).toContain(
            'MediaPipe selected for future article and EPUB TTS');
        expect(source).toContain(
            'Comparison silently changed the selected TTS backend');
        const measureIdx = source.indexOf(
            'Editing shared sample did not clear both provider rows');
        const onnxClickIdx = source.search(
            /locator\(\s*['`][^'`]*\[data-variant="onnx-q8"\] \.model-choose[^'`]*['`]\s*\)\.click\(\)/);
        expect(measureIdx).toBeGreaterThan(0);
        expect(onnxClickIdx).toBeGreaterThan(measureIdx);
    });

    test('Firefox dual comparison clicks Use this backend after measure', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toContain('def accept_two_backend_comparison');
        expectChooseClick(source, 'onnx-q8', 'firefox');
        expectChooseClick(source, 'mediapipe-cpu', 'firefox');
        expect(source).toContain('useThisBackend');
        expect(source).toContain('preferenceOnlyOnChoose');
        expect(source).toContain('backendSelectionUnchangedDuringMeasure');
        expect(source).not.toMatch(
            /"backendSelectionUnchanged":\s*True\b/);
        expect(source).toContain(
            'ONNX q8 selected for dictionary-supported English');
        expect(source).toContain(
            'MediaPipe selected for future article and EPUB TTS');
        expect(source).toContain(
            'Firefox dual comparison silently changed the selected backend');
        const measureIdx = source.indexOf(
            'Firefox dual comparison retained stale rows after sample edit');
        const onnxClickIdx = source.search(
            /find_element\(\s*By\.CSS_SELECTOR,\s*['"]\[data-variant="onnx-q8"\] \.model-choose['"]\s*\)\s*\.click\(\)/s);
        expect(measureIdx).toBeGreaterThan(0);
        expect(onnxClickIdx).toBeGreaterThan(measureIdx);
    });

    test('workflow exposes chromium and firefox dual-comparison scopes', () => {
        const source = fs.readFileSync(workflow, 'utf8');
        expect(source).toContain('- chromium-dual-comparison');
        expect(source).toContain('- firefox-dual-comparison');
        expect(source).toContain(
            'KOKORO_FIREFOX_DUAL_COMPARISON: ${{ inputs.acceptance_scope == \'firefox-dual-comparison\' && \'1\' || \'0\' }}');
    });
});
