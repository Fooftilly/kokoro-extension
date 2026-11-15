/** @jest-environment node */
/**
 * Contract for dual-scope longer shared English paragraph (#61 / KE-32).
 */
const fs = require('fs');
const path = require('path');
const {
    LONGER_SHARED_ENGLISH_SAMPLE,
    LONGER_SHARED_ENGLISH_BUTTON_ID,
    assertLongerSharedEnglishSample,
} = require('../longer-shared-english-sample.js');

const root = path.join(__dirname, '..');
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const modelManager = path.join(root, 'model-manager-page.js');
const benchmarkHtml = path.join(root, 'benchmark.html');
const buildJs = path.join(root, 'build.js');

describe('Longer shared English sample acceptance', () => {
    test('sample is multi-sentence and longer than Hello world.', () => {
        expect(LONGER_SHARED_ENGLISH_SAMPLE.split(/[.!?]/).filter(Boolean).length)
            .toBeGreaterThanOrEqual(2);
        expect(LONGER_SHARED_ENGLISH_SAMPLE.length)
            .toBeGreaterThan('Hello world.'.length);
        expect(LONGER_SHARED_ENGLISH_SAMPLE).not.toMatch(/\d/);
        expect(() => assertLongerSharedEnglishSample(LONGER_SHARED_ENGLISH_SAMPLE))
            .not.toThrow();
        expect(() => assertLongerSharedEnglishSample('Hello world.'))
            .toThrow(/Expected longer shared English sample/);
    });

    test('product wires Use longer sample control', () => {
        const html = fs.readFileSync(benchmarkHtml, 'utf8');
        const source = fs.readFileSync(modelManager, 'utf8');
        const build = fs.readFileSync(buildJs, 'utf8');
        expect(html).toContain('id="' + LONGER_SHARED_ENGLISH_BUTTON_ID + '"');
        expect(html).toContain('Use longer sample');
        expect(source).toContain('longer-shared-english-sample.js');
        expect(source).toContain('LONGER_SHARED_ENGLISH_SAMPLE');
        expect(source).toContain('applyLongerSharedEnglishSample');
        expect(build).toContain("'longer-shared-english-sample.js'");
    });

    test('Chromium dual path loads longer sample before measure', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        // Node harness must bridge via temp .mjs (package.json is CommonJS).
        expect(source).not.toMatch(
            /from ['"]\.\.\/longer-shared-english-sample\.js['"]/);
        expect(source).toContain('kokoro-longer-shared-english-sample.mjs');
        expect(source).toContain('longer-shared-english-sample.js');
        expect(source).toContain('LONGER_SHARED_ENGLISH_BUTTON_ID');
        expect(source).toContain('assertLongerSharedEnglishSample');
        expect(source).toContain('timeout: 600000');
        const clickIdx = source.indexOf(
            "await page.locator('#' + LONGER_SHARED_ENGLISH_BUTTON_ID).click()");
        const measureIdx = source.indexOf(
            "await page.locator('[data-variant=\"' + key + '\"] .model-test').click()");
        expect(clickIdx).toBeGreaterThan(0);
        expect(measureIdx).toBeGreaterThan(clickIdx);
        expect(source).toContain(
            'sampleText: LONGER_SHARED_ENGLISH_SAMPLE');
        expect(source).toContain(
            'sharedSample: LONGER_SHARED_ENGLISH_SAMPLE');
    });

    test('Firefox dual path matches JS sample constant', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        // Python splits the literal across lines; assert both halves + identity.
        expect(source).toContain(
            'Hello friends. Please measure this longer English paragraph carefully');
        expect(source).toContain(
            'so both local systems share one sample.');
        expect(source).toContain(LONGER_SHARED_ENGLISH_BUTTON_ID);
        expect(source).toContain('WebDriverWait(driver, 600)');
        expect(source).toContain(
            'sample_text=LONGER_SHARED_ENGLISH_SAMPLE');
        expect(source).toContain(
            '"sharedSample": LONGER_SHARED_ENGLISH_SAMPLE');
        const reconstructed = source.match(
            /LONGER_SHARED_ENGLISH_SAMPLE = \(\s*"([^"]+)"\s*"([^"]+)"\s*\)/);
        expect(reconstructed).not.toBeNull();
        expect(reconstructed[1] + reconstructed[2])
            .toBe(LONGER_SHARED_ENGLISH_SAMPLE);
    });
});
