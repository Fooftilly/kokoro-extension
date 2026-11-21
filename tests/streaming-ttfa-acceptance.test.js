/** @jest-environment node */
/**
 * Contract for FastAPI streamed first-body-byte (TTFB) + post-download playback
 * start (#61 / KE-34 + KE-40) and explicit MediaSource progressive TTFA honesty
 * (#61 / KE-41c). Must not claim MediaSource streaming TTFA.
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
        expect(source).toContain('MediaSource progressive TTFA not measured');
        expect(source).toContain('progressive MediaSource TTFA measured');
        expect(source).toContain('progressive MediaSource TTFA unavailable');
        expect(source).toContain('measureProgressiveMediaSourceTtfa');
        expect(source).toContain('measureFastApiProgressiveMediaSourceTtfa');
        expect(source).toContain('probeMediaSourceProgressiveMp3Support');
        expect(source).toContain('progressiveTtfaUnavailable');
        expect(source).toContain('cancelReadableStreamBody');
        expect(source).toContain('readBoundedResponseText');
        expect(source).toContain('DEFAULT_PROGRESSIVE_TTFA_TIMEOUT_MS');
        // Re-check fastapi before progressive POST (local-mode must not leak).
        expect(source).toContain(
            "selected.ttsBackend !== 'fastapi'");
        // Storage get failure → progressive unavailable (playable path kept).
        expect(source).toContain('Progressive settings read failed');
        const progressiveFn = source.slice(
            source.indexOf('async function measureFastApiProgressiveMediaSourceTtfa'),
            source.indexOf('async function fetchFastApiPlayableClip'));
        expect(progressiveFn).toMatch(
            /try\s*\{[\s\S]*storage\.sync\.get[\s\S]*\}\s*catch/);
        expect(progressiveFn.indexOf('storage.sync.get'))
            .toBeLessThan(progressiveFn.indexOf('fetch(endpoint'));
        expect(progressiveFn.indexOf('Progressive settings read failed'))
            .toBeLessThan(progressiveFn.indexOf('fetch(endpoint'));
        // Header deadline must arm before await fetch (hung headers → unavailable).
        expect(progressiveFn.indexOf('headerDeadlineTimer = setTimeout'))
            .toBeLessThan(progressiveFn.indexOf('await fetch(endpoint'));
        expect(progressiveFn).toContain('readBoundedResponseText(response)');
        // Playable-clip path is separate — storage failure must not sit on it.
        const playableFn = source.slice(
            source.indexOf('async function fetchFastApiPlayableClip'),
            source.indexOf('function applyProgressiveMediaSourceTtfaStatus'));
        expect(playableFn).not.toContain('Progressive settings read failed');
        expect(source).toContain(
            "mediasourceProgressiveTtfaMeasured = 'true'");
        expect(source).toContain(
            "mediasourceProgressiveTtfaMeasured = 'false'");
        expect(source).toContain(
            "mediasourceProgressiveTtfaNotMeasured = 'true'");
        expect(source).toContain('mediasourceProgressiveTtfaP50Ms');
        expect(source).toContain(
            "from './server-audio-playback-start.js'");
        expect(source).toContain('waitServerAudioPlaybackStart');
        expect(source).toContain('streamingFirstBodyByteMeasured');
        expect(source).toContain('playbackStartMeasured');
        expect(source).toContain('playbackStartP50Ms');
        expect(source).toContain('summarizeRuns(warm.runs)');
        expect(source).toContain('collectFastApiWarmRuns');
        expect(source).toContain('applyProgressiveMediaSourceTtfaStatus');
        expect(source).toContain('nearestRank');
        expect(source).not.toContain('Streaming TTFA p50');
        expect(source).toMatch(/for \(let n = 0; n < 3; n\+\+\)/);
        const ttfbIdx = source.indexOf(
            'First body byte (TTFB) was not measured');
        expect(ttfbIdx).toBeGreaterThan(0);
        expect(source).toContain('waitServerAudioDuration(audio)');
        expect(source).toContain('audioDurationSec: durationSec');
        expect(source).toContain('playbackStartMs');
        const helper = fs.readFileSync(
            path.join(root, 'server-audio-playback-start.js'), 'utf8');
        expect(helper).toContain('wasMuted');
        expect(helper).toContain('audio.muted = wasMuted');
        expect(helper).toContain('finally');
        const build = fs.readFileSync(path.join(root, 'build.js'), 'utf8');
        expect(build).toContain("'server-audio-playback-start.js'");
        expect(build).toContain("'mediasource-progressive-ttfa.js'");
    });

    test('testFastApi discards an untimed warm-up before three warm runs', () => {
        const source = fs.readFileSync(
            path.join(root, 'model-manager-page.js'), 'utf8');
        expect(source).toContain('fetchFastApiPlayableClip');
        expect(source).toContain('after untimed warm-up');
        expect(source).toContain(
            'Untimed warm-up absorbs cold FastAPI/model init');
        const collectStart = source.indexOf(
            'async function collectFastApiWarmRuns(');
        expect(collectStart).toBeGreaterThan(0);
        const collectBody = source.slice(collectStart, collectStart + 1800);
        expect(collectBody).toContain('for (let n = 0; n < 3; n++)');
        expect(collectBody).toContain("kind: 'warm'");
        const fnStart = source.indexOf('async function testFastApi()');
        expect(fnStart).toBeGreaterThan(0);
        const fnBody = source.slice(fnStart, fnStart + 2800);
        const warmUpIdx = fnBody.indexOf(
            'await fetchFastApiPlayableClip(\n' +
            '            endpoint.href, input, settings.voice, audio);');
        const collectIdx = fnBody.indexOf('await collectFastApiWarmRuns(');
        expect(warmUpIdx).toBeGreaterThan(0);
        expect(collectIdx).toBeGreaterThan(warmUpIdx);
        // Untimed warm-up must not push into runs (only collectFastApiWarmRuns).
        expect(fnBody.slice(warmUpIdx, collectIdx)).not.toContain('runs.push');
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
        expect(source).toContain(
            'SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE');
        expect(source).toContain(
            'SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_MEASURED_NEEDLE');
        expect(source).toContain('mediasourceProgressiveTtfaMeasured');
        expect(source).toContain('mediasourceProgressiveTtfaNotMeasured');
        expect(source).toContain('mediasourceProgressiveTtfaP50Ms');
        expect(source).toContain('MediaSource progressive TTFA not measured');
        expect(source).toContain('progressive MediaSource TTFA measured');
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
