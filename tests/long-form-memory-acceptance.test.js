/** @jest-environment node */
/**
 * Contract checks for long-form memory acceptance — keep this file's shape
 * distinct from article-selection-acceptance.test.js (Sonar new-code duplication).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'long-form-memory-acceptance.mjs')).href;

function loadHelperSnapshot() {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as longForm from ${JSON.stringify(helperUrl)};
const speech = longForm.buildLongFormSpeechLines();
const pending = longForm.buildLongFormPendingContent();
const cfg = longForm.longFormStorageConfig('onnx');
const sampleStats = {
    cacheSize: 4,
    objectUrlCount: 3,
    sentenceCount: longForm.LONG_FORM_SENTENCE_COUNT,
};
const capture = (fn) => {
    try { fn(); return { ok: true }; }
    catch (error) { return { ok: false, message: String(error.message || error) }; }
};
console.log(JSON.stringify({
    sentenceCount: longForm.LONG_FORM_SENTENCE_COUNT,
    speechHead: speech.slice(0, 3),
    speechTail: speech.slice(-2),
    pendingLen: pending.length,
    pendingShape: pending[0],
    cfgKeys: Object.keys(cfg).sort(),
    probeArmed: cfg.pendingAcceptanceProbe === true,
    autoplayDisabled: cfg.pendingAutoplay === false,
    offlineApi: cfg.apiUrl === '' && cfg.pendingApiUrl === null,
    backend: cfg.pendingTtsBackend,
    stageTruthTable: {
        onnxOriginOk: longForm.originLongFormMemoryStageEnabled(true, 'onnx', true),
        mediapipeBlocked: longForm.originLongFormMemoryStageEnabled(true, 'mediapipe', true),
        noOrigin: longForm.originLongFormMemoryStageEnabled(false, 'onnx', true),
        priorFailure: longForm.originLongFormMemoryStageEnabled(true, 'onnx', false),
    },
    statsPass: capture(() => longForm.assertBoundedAudioManagerStats(sampleStats)),
    statsCacheFail: capture(() => longForm.assertBoundedAudioManagerStats({
        ...sampleStats, cacheSize: longForm.LONG_FORM_MAX_CACHE_ENTRIES + 3,
    })),
    statsUrlFail: capture(() => longForm.assertBoundedAudioManagerStats({
        ...sampleStats, objectUrlCount: longForm.LONG_FORM_MAX_OBJECT_URLS + 3,
    })),
    heapPass: longForm.assertLongFormHeapDelta(50, 75),
    heapFail: capture(() => longForm.assertLongFormHeapDelta(0, 300 * 1024 * 1024)),
    mediapipeReject: capture(() => longForm.requireLongFormBackend('mediapipe')),
    bounds: {
        cache: longForm.LONG_FORM_MAX_CACHE_ENTRIES,
        urls: longForm.LONG_FORM_MAX_OBJECT_URLS,
    },
}));
`], { encoding: 'utf8', cwd: root });
    return child;
}

describe('long-form memory acceptance', () => {
    test('helper snapshot covers document, probe storage, bounds, and gates', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.sentenceCount).toBe(24);
        expect(snap.pendingLen).toBe(24);
        expect(snap.speechHead).toEqual([
            'Hello one.', 'Hello two.', 'Hello three.',
        ]);
        expect(snap.speechTail).toEqual(['Hello fifty.', 'Hello sixty.']);
        expect(snap.pendingShape).toEqual({ type: 'text', content: 'Hello one.' });
        expect(snap.backend).toBe('onnx');
        expect(snap.probeArmed).toBe(true);
        expect(snap.autoplayDisabled).toBe(true);
        expect(snap.offlineApi).toBe(true);
        expect(snap.cfgKeys).toEqual(expect.arrayContaining([
            'pendingAcceptanceProbe', 'pendingContent', 'pendingTtsBackend',
        ]));
        expect(snap.stageTruthTable).toEqual({
            onnxOriginOk: true,
            mediapipeBlocked: false,
            noOrigin: false,
            priorFailure: false,
        });
        expect(snap.statsPass).toEqual({ ok: true });
        expect(snap.statsCacheFail.ok).toBe(false);
        expect(snap.statsCacheFail.message).toMatch(/cache exceeded/);
        expect(snap.statsUrlFail.ok).toBe(false);
        expect(snap.statsUrlFail.message).toMatch(/object URLs exceeded/);
        expect(snap.heapPass.growth).toBe(25);
        expect(snap.heapFail.ok).toBe(false);
        expect(snap.heapFail.message).toMatch(/heap growth exceeded/);
        expect(snap.mediapipeReject.ok).toBe(false);
        expect(snap.bounds).toEqual({ cache: 8, urls: 8 });
    });

    test('overlay probe and long-form stage are wired for Chromium origin', () => {
        const harness = fs.readFileSync(
            path.join(root, 'scripts', 'validate-live-chromium.mjs'), 'utf8');
        const overlay = fs.readFileSync(path.join(root, 'overlay.js'), 'utf8');
        expect(harness).toContain("from './long-form-memory-acceptance.mjs'");
        expect(harness).toContain('acceptLongFormMemoryPerformance');
        expect(harness).toContain('longFormMemoryAcceptance');
        expect(harness).toContain('offline-real-long-form-memory');
        // After article/selection the Playwright page is still on the HTTP
        // fixture — storage must be seeded via the extension service worker.
        expect(harness).toMatch(
            /long-form storage seed[\s\S]{0,200}serviceWorkers|serviceWorkers\(\)\[0\][\s\S]{0,400}long-form storage seed/,
        );
        expect(harness).toContain('long-form storage seed');
        expect(overlay).toContain('pendingAcceptanceProbe');
        expect(overlay).toContain('__kokoroAudioManagerStats');
        expect(overlay).toContain('audioManager.audioCache.size');
        expect(overlay).toContain('audioManager.objectUrls.size');
    });
});
