/** @jest-environment node */
/**
 * Contract for FastAPI streamed first-body-byte (TTFB) + post-download playback
 * start (#61 / KE-34 + KE-40). Must not claim MediaSource streaming TTFA.
 * Local export stays firstAudioMeasured:false.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

describe('Streaming first-body-byte acceptance (KE-34 / KE-40)', () => {
    test('background streams response body for firstBodyByteMs', () => {
        const source = fs.readFileSync(
            path.join(root, 'background.js'), 'utf8');
        expect(source).toContain('readTtsResponseAsDataUrl');
        expect(source).toContain('firstBodyByteMs');
        expect(source).toContain('getReader');
        expect(source).toContain('firstBodyByteMs: null');
        expect(source).toContain('TTFB, not decoded/playable TTFA');
    });

    test('testFastApi labels TTFB and measures post-download playback start', () => {
        const source = fs.readFileSync(
            path.join(root, 'model-manager-page.js'), 'utf8');
        expect(source).toContain('First body byte (TTFB) p50');
        expect(source).toContain('playback start p50');
        expect(source).toContain('not MediaSource streaming TTFA');
        expect(source).toContain('waitServerAudioPlaybackStart');
        expect(source).toContain('streamingFirstBodyByteMeasured');
        expect(source).toContain('playbackStartMeasured');
        expect(source).toContain('playbackStartP50Ms');
        expect(source).toContain('summarizeRuns(runs)');
        expect(source).toContain('nearestRank');
        expect(source).not.toContain('Streaming TTFA p50');
        expect(source).toMatch(/for \(let n = 0; n < 3; n\+\+\)/);
        const ttfbIdx = source.indexOf(
            'First body byte (TTFB) was not measured');
        expect(ttfbIdx).toBeGreaterThan(0);
        expect(source).toContain('waitServerAudioDuration(audio)');
        expect(source).toContain('audioDurationSec: durationSec');
        expect(source).toContain('playbackStartMs');
    });

    test('testFastApi discards an untimed warm-up before three warm runs', () => {
        const source = fs.readFileSync(
            path.join(root, 'model-manager-page.js'), 'utf8');
        expect(source).toContain('fetchFastApiPlayableClip');
        expect(source).toContain('after untimed warm-up');
        expect(source).toContain(
            'Untimed warm-up absorbs cold FastAPI/model init');
        const fnStart = source.indexOf('async function testFastApi()');
        expect(fnStart).toBeGreaterThan(0);
        const fnBody = source.slice(fnStart, fnStart + 3600);
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

    test('server-card assert requires playback start at/after full response', () => {
        const source = fs.readFileSync(
            path.join(root, 'scripts', 'fastapi-server-card-acceptance.mjs'),
            'utf8');
        expect(source).toContain(
            'synthesisP50Ms must be strictly greater than firstBodyByteP50Ms');
        expect(source).toContain('firstBodyByteP50Ms >= 50');
        expect(source).toContain('playbackStartMeasured');
        expect(source).toContain('playbackStartP50Ms must be at/after');
        expect(source).toContain('post-download start, not MediaSource');
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
