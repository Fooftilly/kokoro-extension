/** @jest-environment node */
/**
 * Contract for FastAPI streamed first-body-byte (TTFB) labeling (#61 / KE-34).
 * Must not claim decoded/playable TTFA. Local export stays firstAudioMeasured:false.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

describe('Streaming first-body-byte acceptance (KE-34)', () => {
    test('background streams response body for firstBodyByteMs', () => {
        const source = fs.readFileSync(
            path.join(root, 'background.js'), 'utf8');
        expect(source).toContain('readTtsResponseAsDataUrl');
        expect(source).toContain('firstBodyByteMs');
        expect(source).toContain('getReader');
        expect(source).toContain('firstBodyByteMs: null');
        expect(source).toContain('TTFB, not decoded/playable TTFA');
    });

    test('testFastApi labels TTFB and denies playable TTFA claims', () => {
        const source = fs.readFileSync(
            path.join(root, 'model-manager-page.js'), 'utf8');
        expect(source).toContain('First body byte (TTFB) p50');
        expect(source).toContain('Playback / start-of-audio was not measured');
        expect(source).toContain('streamingFirstBodyByteMeasured');
        expect(source).toContain('playbackStartNotMeasured');
        expect(source).toContain('firstBodyByteP50Ms');
        expect(source).toContain('summarizeRuns(runs)');
        expect(source).not.toContain('Streaming TTFA p50');
        expect(source).toMatch(/for \(let n = 0; n < 3; n\+\+\)/);
        const ttfbIdx = source.indexOf(
            'First body byte (TTFB) was not measured');
        expect(ttfbIdx).toBeGreaterThan(0);
        const loopBody = source.slice(
            source.indexOf('need a streamed response body'),
            source.indexOf('need a streamed response body') + 900);
        expect(loopBody).toContain('waitServerAudioDuration(audio)');
        expect(loopBody).toContain('audioDurationSec: durationSec');
    });

    test('server-card assert rejects equal first-byte and full-response p50', () => {
        const source = fs.readFileSync(
            path.join(root, 'scripts', 'fastapi-server-card-acceptance.mjs'),
            'utf8');
        expect(source).toContain(
            'synthesisP50Ms must be strictly greater than firstBodyByteP50Ms');
        expect(source).toContain('firstBodyByteP50Ms >= 50');
        expect(source).toContain('playbackStartNotMeasured');
        expect(source).toContain('TTFB ≠ playable TTFA');
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
