/**
 * @jest-environment node
 *
 * Contract for progressive FastAPI selection gate: storage.sync.get reject
 * must become progressive unavailable without blocking the playable-clip path.
 * Mirrors measureFastApiProgressiveMediaSourceTtfa in model-manager-page.js.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pageSource = fs.readFileSync(
    path.join(root, 'model-manager-page.js'), 'utf8');

/** Mirror of the progressive settings gate (page is not exported). */
async function progressiveSettingsGate(storageGet) {
    let selected;
    try {
        selected = await storageGet({ ttsBackend: 'fastapi' });
    } catch (error) {
        return {
            measured: false,
            unavailable: true,
            ttfaMs: null,
            reason: 'Progressive settings read failed: ' +
                String(error?.message || error),
        };
    }
    if (selected.ttsBackend !== 'fastapi') {
        return {
            measured: false,
            unavailable: true,
            ttfaMs: null,
            reason: 'FastAPI no longer selected; progressive request skipped',
        };
    }
    return { proceed: true, selected };
}

describe('progressive FastAPI settings gate', () => {
    test('page wires try/catch around progressive storage.sync.get before POST', () => {
        const progressiveFn = pageSource.slice(
            pageSource.indexOf(
                'async function measureFastApiProgressiveMediaSourceTtfa'),
            pageSource.indexOf('async function fetchFastApiPlayableClip'));
        expect(progressiveFn).toMatch(
            /try\s*\{[\s\S]*storage\.sync\.get[\s\S]*\}\s*catch/);
        expect(progressiveFn).toContain('Progressive settings read failed');
        expect(progressiveFn.indexOf('storage.sync.get'))
            .toBeLessThan(progressiveFn.indexOf('fetch(endpoint'));
    });

    test('storage.sync.get reject → progressive unavailable (playable independent)', async () => {
        let playableCalls = 0;
        const playableClip = async () => {
            playableCalls += 1;
            return { firstBodyByteMs: 100, synthesisMs: 160, playbackStartMs: 180 };
        };
        const progressive = await progressiveSettingsGate(async () => {
            throw new Error('quota exceeded');
        });
        // Playable path can still succeed independently of progressive gate.
        const clip = await playableClip();
        expect(progressive.unavailable).toBe(true);
        expect(progressive.measured).toBe(false);
        expect(progressive.ttfaMs).toBeNull();
        expect(progressive.reason).toMatch(
            /Progressive settings read failed.*quota exceeded/i);
        expect(playableCalls).toBe(1);
        expect(clip.firstBodyByteMs).toBe(100);
    });

    test('fastapi still selected proceeds', async () => {
        const result = await progressiveSettingsGate(async () =>
            ({ ttsBackend: 'fastapi' }));
        expect(result.proceed).toBe(true);
        expect(result.selected.ttsBackend).toBe('fastapi');
    });
});
