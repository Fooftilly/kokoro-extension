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
        // Each warm clip must decode before it enters the p50.
        const ttfaIdx = source.indexOf(
            'Streaming TTFA was not measured (need a streamed response body)');
        expect(ttfaIdx).toBeGreaterThan(0);
        const loopBody = source.slice(ttfaIdx, ttfaIdx + 600);
        expect(loopBody).toContain('waitServerAudioDuration(audio)');
        expect(loopBody).toContain('audioDurationSec: durationSec');
    });

    test('server-card assert rejects equal first-audio and full-response p50', () => {
        const source = fs.readFileSync(
            path.join(root, 'scripts', 'fastapi-server-card-acceptance.mjs'),
            'utf8');
        expect(source).toContain(
            'synthesisP50Ms must be strictly greater than firstAudioP50Ms');
        expect(source).toContain('firstAudioP50Ms >= 50');
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
