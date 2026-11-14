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

describe('dual Use this backend acceptance', () => {
    test('Chromium dual comparison clicks Use this backend after measure', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toContain('async function acceptTwoBackendComparison');
        expect(source).toContain('providerFilter === \'both\' && !originDownload');
        expect(source).toContain('[data-variant="onnx-q8"] .model-choose');
        expect(source).toContain('[data-variant="mediapipe-cpu"] .model-choose');
        expect(source).toContain('useThisBackend');
        expect(source).toContain('preferenceOnlyOnChoose');
        expect(source).toContain("ttsBackend === 'onnx'");
        expect(source).toContain("ttsBackend === 'mediapipe'");
        expect(source).toContain('Comparison silently changed the selected TTS backend');
        // Prefer choose after measure — not during the measurement loop.
        const measureIdx = source.indexOf('Editing shared sample did not clear both provider rows');
        const onnxChooseIdx = source.indexOf('[data-variant="onnx-q8"] .model-choose');
        expect(measureIdx).toBeGreaterThan(0);
        expect(onnxChooseIdx).toBeGreaterThan(measureIdx);
    });

    test('Firefox dual comparison clicks Use this backend after measure', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toContain('def accept_two_backend_comparison');
        expect(source).toContain('[data-variant="onnx-q8"] .model-choose');
        expect(source).toContain('[data-variant="mediapipe-cpu"] .model-choose');
        expect(source).toContain('useThisBackend');
        expect(source).toContain('preferenceOnlyOnChoose');
        expect(source).toContain('selected_backend() == "onnx"');
        expect(source).toContain('selected_backend() == "mediapipe"');
        expect(source).toContain(
            'Firefox dual comparison silently changed the selected backend');
        const measureIdx = source.indexOf(
            'Firefox dual comparison retained stale rows after sample edit');
        const onnxChooseIdx = source.indexOf(
            '[data-variant="onnx-q8"] .model-choose');
        expect(measureIdx).toBeGreaterThan(0);
        expect(onnxChooseIdx).toBeGreaterThan(measureIdx);
    });

    test('workflow exposes chromium and firefox dual-comparison scopes', () => {
        const source = fs.readFileSync(workflow, 'utf8');
        expect(source).toContain('- chromium-dual-comparison');
        expect(source).toContain('- firefox-dual-comparison');
        expect(source).toContain(
            'KOKORO_FIREFOX_DUAL_COMPARISON: ${{ inputs.acceptance_scope == \'firefox-dual-comparison\' && \'1\' || \'0\' }}');
    });
});
