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
        expect(source).toContain('waitServerAudioDuration(audio)');
        expect(source).toContain('audioDurationSec: durationSec');
    });

    test('testFastApi discards an untimed warm-up before three warm runs', () => {
        const source = fs.readFileSync(
            path.join(root, 'model-manager-page.js'), 'utf8');
        expect(source).toContain('fetchFastApiPlayableClip');
        expect(source).toContain('after untimed warm-up; 3 warm runs');
        expect(source).toContain(
            'Untimed warm-up absorbs cold FastAPI/model init');
        const fnStart = source.indexOf('async function testFastApi()');
        expect(fnStart).toBeGreaterThan(0);
        const fnBody = source.slice(fnStart, fnStart + 2800);
        const warmUpIdx = fnBody.indexOf(
            'await fetchFastApiPlayableClip(\n' +
            '            endpoint.href, input, settings.voice, audio);');
        const loopIdx = fnBody.indexOf('for (let n = 0; n < 3; n++)');
        const pushIdx = fnBody.indexOf("kind: 'warm'");
        expect(warmUpIdx).toBeGreaterThan(0);
        expect(loopIdx).toBeGreaterThan(warmUpIdx);
        expect(pushIdx).toBeGreaterThan(loopIdx);
        // Warm-up call must not push into runs (only the measured loop does).
        expect(fnBody.slice(warmUpIdx, loopIdx)).not.toContain('runs.push');
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
