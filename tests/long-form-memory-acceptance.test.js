/** @jest-environment node */
/**
 * Executable contract for Chromium long-form memory acceptance helpers.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const scriptsDir = path.join(__dirname, '..', 'scripts');
const helperModule = path.join(scriptsDir, 'long-form-memory-acceptance.mjs');
const chromiumLive = path.join(scriptsDir, 'validate-live-chromium.mjs');
const overlaySource = path.join(__dirname, '..', 'overlay.js');

function runHelperProbe(jsSnippet) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(helperModule)}).href);
const {
    ALLOWED_LONG_FORM_BACKENDS,
    LONG_FORM_MAX_CACHE_ENTRIES,
    LONG_FORM_MAX_OBJECT_URLS,
    LONG_FORM_NUMBER_WORDS,
    LONG_FORM_SENTENCE_COUNT,
    assertBoundedAudioManagerStats,
    assertLongFormHeapDelta,
    buildLongFormPendingContent,
    buildLongFormSpeechLines,
    longFormStorageConfig,
    originLongFormMemoryStageEnabled,
    requireLongFormBackend,
} = mod;
${jsSnippet}
`], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
}

describe('long-form memory acceptance helpers', () => {
    test('gates Chromium ONNX origin and builds a long offline document', () => {
        const result = runHelperProbe(`
const lines = buildLongFormSpeechLines();
const content = buildLongFormPendingContent();
const storage = longFormStorageConfig('onnx');
const report = {
    allowed: [...ALLOWED_LONG_FORM_BACKENDS],
    count: LONG_FORM_SENTENCE_COUNT,
    words: LONG_FORM_NUMBER_WORDS.length,
    lines: lines.length,
    contentLen: content.length,
    first: lines[0],
    last: lines[lines.length - 1],
    storageBackend: storage.pendingTtsBackend,
    probe: storage.pendingAcceptanceProbe,
    autoplay: storage.pendingAutoplay,
    apiUrl: storage.apiUrl,
    stageOn: originLongFormMemoryStageEnabled(true, 'onnx', true),
    stageOffProvider: originLongFormMemoryStageEnabled(true, 'mediapipe', true),
    stageOffOrigin: originLongFormMemoryStageEnabled(false, 'onnx', true),
    stageOffSuccess: originLongFormMemoryStageEnabled(true, 'onnx', false),
};
let rejected = [];
for (const bad of ['mediapipe', 'fastapi', '']) {
    try { requireLongFormBackend(bad); rejected.push('accepted:' + bad); }
    catch (error) { rejected.push(String(error.message || error)); }
}
report.rejected = rejected;
console.log(JSON.stringify(report));
`);
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const report = JSON.parse(result.stdout.trim());
        expect(report.allowed).toEqual(['onnx']);
        expect(report.count).toBe(24);
        expect(report.lines).toBe(24);
        expect(report.contentLen).toBe(24);
        expect(report.first).toBe('Hello one.');
        expect(report.last).toBe('Hello sixty.');
        expect(report.storageBackend).toBe('onnx');
        expect(report.probe).toBe(true);
        expect(report.autoplay).toBe(false);
        expect(report.apiUrl).toBe('');
        expect(report.stageOn).toBe(true);
        expect(report.stageOffProvider).toBe(false);
        expect(report.stageOffOrigin).toBe(false);
        expect(report.stageOffSuccess).toBe(false);
        expect(report.rejected.every(line => /onnx/.test(line))).toBe(true);
    });

    test('rejects unbounded AudioManager stats and oversized heap growth', () => {
        const result = runHelperProbe(`
const ok = assertBoundedAudioManagerStats({
    cacheSize: 5, objectUrlCount: 5, sentenceCount: LONG_FORM_SENTENCE_COUNT,
    window: { first: 10, last: 14 }, generation: 1,
});
let cacheFail = null;
try {
    assertBoundedAudioManagerStats({
        cacheSize: LONG_FORM_MAX_CACHE_ENTRIES + 1,
        objectUrlCount: 1,
        sentenceCount: LONG_FORM_SENTENCE_COUNT,
    });
} catch (error) { cacheFail = String(error.message || error); }
let urlFail = null;
try {
    assertBoundedAudioManagerStats({
        cacheSize: 1,
        objectUrlCount: LONG_FORM_MAX_OBJECT_URLS + 1,
        sentenceCount: LONG_FORM_SENTENCE_COUNT,
    });
} catch (error) { urlFail = String(error.message || error); }
const heap = assertLongFormHeapDelta(100, 100 + 1024);
let heapFail = null;
try { assertLongFormHeapDelta(0, 512 * 1024 * 1024); }
catch (error) { heapFail = String(error.message || error); }
console.log(JSON.stringify({ ok, cacheFail, urlFail, heap, heapFail,
    maxCache: LONG_FORM_MAX_CACHE_ENTRIES, maxUrls: LONG_FORM_MAX_OBJECT_URLS }));
`);
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout.trim());
        expect(report.ok).toBe(true);
        expect(report.cacheFail).toMatch(/cache exceeded/);
        expect(report.urlFail).toMatch(/object URLs exceeded/);
        expect(report.heap.growth).toBe(1024);
        expect(report.heapFail).toMatch(/heap growth exceeded/);
        expect(report.maxCache).toBe(8);
        expect(report.maxUrls).toBe(8);
    });

    test('live Chromium harness wires long-form stage and opt-in overlay probe', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        const overlay = fs.readFileSync(overlaySource, 'utf8');
        expect(source).toMatch(/originLongFormMemoryStageEnabled/);
        expect(source).toMatch(/acceptLongFormMemoryPerformance/);
        expect(source).toMatch(/longFormMemoryAcceptance/);
        expect(source).toMatch(/offline-real-long-form-memory/);
        expect(source).toMatch(/longFormStorageConfig/);
        expect(overlay).toMatch(/pendingAcceptanceProbe/);
        expect(overlay).toMatch(/__kokoroAudioManagerStats/);
    });
});
