/** @jest-environment node */
/**
 * Executable contract for Chromium article/selection acceptance helpers.
 * Shells out to Node ESM so CommonJS Jest does not re-embed the fixture.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const scriptsDir = path.join(__dirname, '..', 'scripts');
const helperModule = path.join(scriptsDir, 'article-selection-acceptance.mjs');
const chromiumLive = path.join(scriptsDir, 'validate-live-chromium.mjs');

function runHelperProbe(jsSnippet) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(helperModule)}).href);
const {
    ALLOWED_ARTICLE_SELECTION_BACKENDS,
    ARTICLE_SELECTION_SPEECH,
    articleSelectionStorageConfig,
    assertDistinctArticleSelectionAudioHashes,
    buildArticleSelectionFixtureHtml,
    originArticleSelectionStageEnabled,
    requireArticleSelectionBackend,
} = mod;
${jsSnippet}
`], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
}

describe('article/selection acceptance helpers', () => {
    test('gates Chromium ONNX origin only and configures local storage', () => {
        const result = runHelperProbe(`
const report = {
    allowed: [...ALLOWED_ARTICLE_SELECTION_BACKENDS],
    required: requireArticleSelectionBackend('onnx'),
    storage: articleSelectionStorageConfig('onnx'),
    stageOn: originArticleSelectionStageEnabled(true, 'onnx', true),
    stageOffProvider: originArticleSelectionStageEnabled(true, 'mediapipe', true),
    stageOffOrigin: originArticleSelectionStageEnabled(false, 'onnx', true),
    stageOffSuccess: originArticleSelectionStageEnabled(true, 'onnx', false),
};
let rejected = [];
for (const bad of ['mediapipe', 'fastapi', '']) {
    try { requireArticleSelectionBackend(bad); rejected.push('accepted:' + bad); }
    catch (error) { rejected.push(String(error.message || error)); }
}
report.rejected = rejected;
console.log(JSON.stringify(report));
`);
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const report = JSON.parse(result.stdout.trim());
        expect(report.allowed).toEqual(['onnx']);
        expect(report.required).toBe('onnx');
        expect(report.storage.ttsBackend).toBe('onnx');
        expect(report.storage.showFloatingButton).toBe(true);
        expect(report.storage.apiUrl).toBe('');
        expect(report.storage.mode).toBe('stream');
        expect(report.stageOn).toBe(true);
        expect(report.stageOffProvider).toBe(false);
        expect(report.stageOffOrigin).toBe(false);
        expect(report.stageOffSuccess).toBe(false);
        expect(report.rejected.every(line => /onnx/.test(line))).toBe(true);
    });

    test('fixture HTML carries distinct selection and article speech', () => {
        const result = runHelperProbe(`
const html = buildArticleSelectionFixtureHtml();
console.log(JSON.stringify({
    html,
    speech: ARTICLE_SELECTION_SPEECH,
}));
`);
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout.trim());
        expect(report.html).toContain(report.speech.selection);
        expect(report.html).toContain(report.speech.articleFirst);
        expect(report.html).toContain(report.speech.articleSecond);
        expect(report.html).toContain('id="selection-sentence"');
        expect(report.html).toContain('<article>');
        expect(report.speech.selection).not.toBe(report.speech.articleFirst);
        expect(report.speech.articleFirst).not.toBe(report.speech.articleSecond);
    });

    test('rejects missing or colliding selection/article WAV hashes', () => {
        const result = runHelperProbe(`
const ok = assertDistinctArticleSelectionAudioHashes('aaa', 'bbb');
const errors = [];
for (const args of [['', 'bbb'], ['aaa', null], ['same', 'same']]) {
    try {
        assertDistinctArticleSelectionAudioHashes(...args);
        errors.push('accepted:' + JSON.stringify(args));
    } catch (error) {
        errors.push(String(error.message || error));
    }
}
console.log(JSON.stringify({ ok, errors }));
`);
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout.trim());
        expect(report.ok).toBe(true);
        expect(report.errors).toHaveLength(3);
        expect(report.errors[0]).toMatch(/missing/);
        expect(report.errors[1]).toMatch(/missing/);
        expect(report.errors[2]).toMatch(/collided/);
    });

    test('chromium live harness wires the article/selection stage for ONNX origin', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toMatch(/from '\.\/article-selection-acceptance\.mjs'/);
        expect(source).toMatch(/originArticleSelectionStageEnabled\(/);
        expect(source).toMatch(/acceptRealArticleAndSelection\(/);
        expect(source).toMatch(/articleSelectionAcceptance/);
        expect(source).toMatch(/offline-real-article-and-selection/);
        expect(source).toMatch(/kokoro-float-btn/);
        // Independent extraction probe, then real Alt+A via native X11 XTest
        // (CDP keyboard does not reach chrome.commands.onCommand).
        expect(source).toMatch(/PARSE_ARTICLE/);
        expect(source).toMatch(/native-chromium-keys\.py/);
        expect(source).toMatch(/Alt_L',\s*'a'/);
        expect(source).toMatch(/path: 'read-article-command-native-x11'/);
        expect(source).toMatch(/function liveHeartbeat\(/);
        expect(source).toMatch(/function withTimeout\(/);
        expect(source).not.toMatch(/keyboard\.press\('Alt\+a'\)/);
        expect(source).not.toMatch(/path: 'parse-article-show-player'/);
        expect(source).not.toMatch(
            /pendingTtsBackend: ttsBackend[\s\S]{0,200}SHOW_PLAYER/,
        );
    });

    test('chromium live workflow job timeout covers origin+EPUB+article stages', () => {
        const workflow = fs.readFileSync(
            path.join(__dirname, '..', '.github', 'workflows', 'live-browser-acceptance.yml'),
            'utf8',
        );
        const chromiumJob = workflow.split('chromium-model-inference:')[1]
            ?.split(/\n {2}[a-z]/)[0] || '';
        expect(chromiumJob).toMatch(/timeout-minutes:\s*60\b/);
    });
});
