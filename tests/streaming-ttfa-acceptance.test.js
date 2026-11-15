/** @jest-environment node */
/**
 * Contract for FastAPI streaming TTFA (#61 / KE-34).
 * Local measured export must remain firstAudioMeasured:false.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

describe('Streaming TTFA acceptance (KE-34)', () => {
    test('background streams response body for firstAudioMs', () => {
        const source = fs.readFileSync(
            path.join(root, 'background.js'), 'utf8');
        expect(source).toContain('readTtsResponseAsDataUrl');
        expect(source).toContain('firstAudioMs');
        expect(source).toContain('getReader');
        expect(source).toContain('firstAudioMs: null');
    });

    test('testFastApi measures three warm streaming TTFA runs', () => {
        const source = fs.readFileSync(
            path.join(root, 'model-manager-page.js'), 'utf8');
        expect(source).toContain('Streaming TTFA p50');
        expect(source).toContain('streamingTtfaMeasured');
        expect(source).toContain('firstAudioP50Ms');
        expect(source).toContain('summarizeRuns(runs)');
        expect(source).toContain('Local backends do not measure streaming TTFA');
        expect(source).toMatch(/for \(let n = 0; n < 3; n\+\+\)/);
    });

    test('local measured export still denies first-audio claims', () => {
        const exportHelper = fs.readFileSync(
            path.join(root, 'scripts', 'measured-results-export-acceptance.mjs'),
            'utf8');
        const page = fs.readFileSync(
            path.join(root, 'model-manager-page.js'), 'utf8');
        expect(exportHelper).toContain(
            "requireMeasuredFlag(payload, 'firstAudioMeasured', false");
        expect(page).toContain('firstAudioMeasured: false');
        expect(page).toContain('firstAudioMs: null');
    });
});
