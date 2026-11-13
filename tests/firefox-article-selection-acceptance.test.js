/** @jest-environment node */
/**
 * Executable contract for Firefox article/selection acceptance helpers.
 * Exercises scripts/firefox_article_selection_acceptance.py and verifies the
 * live harness wires the stage — not source-only string contracts.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const scriptsDir = path.join(__dirname, '..', 'scripts');
const helperModule = path.join(scriptsDir, 'article-selection-acceptance.mjs');
const firefoxLive = path.join(scriptsDir, 'validate-live-firefox.py');
const workflow = path.join(
    __dirname, '..', '.github', 'workflows', 'live-browser-acceptance.yml');

function runHelperProbe(pythonSnippet) {
    return spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
from firefox_article_selection_acceptance import (
    ALLOWED_ARTICLE_SELECTION_BACKENDS,
    assert_distinct_article_selection_audio_hashes,
    article_selection_storage_config,
    load_article_selection_fixture,
    origin_article_selection_stage_enabled,
    require_article_selection_backend,
)
${pythonSnippet}
`], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
}

describe('firefox article/selection acceptance backend wiring', () => {
    test('gates Firefox ONNX origin only and configures local storage', () => {
        const result = runHelperProbe(`
report = {
    'allowed': sorted(ALLOWED_ARTICLE_SELECTION_BACKENDS),
    'required': require_article_selection_backend('onnx'),
    'storage': article_selection_storage_config('onnx'),
    'stageOn': origin_article_selection_stage_enabled(True, 'onnx', True),
    'stageOffProvider': origin_article_selection_stage_enabled(True, 'mediapipe', True),
    'stageOffOrigin': origin_article_selection_stage_enabled(False, 'onnx', True),
    'stageOffSuccess': origin_article_selection_stage_enabled(True, 'onnx', False),
}
errors = []
for bad in ('mediapipe', 'fastapi', '', None):
    try:
        require_article_selection_backend(bad)
        errors.append('accepted:' + repr(bad))
    except ValueError as exc:
        errors.append(str(exc))
print(json.dumps({'report': report, 'errors': errors}))
`);
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const payload = JSON.parse(result.stdout.trim());
        expect(payload.report.allowed).toEqual(['onnx']);
        expect(payload.report.required).toBe('onnx');
        expect(payload.report.storage.ttsBackend).toBe('onnx');
        expect(payload.report.storage.showFloatingButton).toBe(true);
        expect(payload.report.storage.apiUrl).toBe('');
        expect(payload.report.storage.mode).toBe('stream');
        expect(payload.report.stageOn).toBe(true);
        expect(payload.report.stageOffProvider).toBe(false);
        expect(payload.report.stageOffOrigin).toBe(false);
        expect(payload.report.stageOffSuccess).toBe(false);
        expect(payload.errors.every(message => message.includes('onnx'))).toBe(true);
        expect(payload.errors.some(message => message.startsWith('accepted:'))).toBe(false);
    });

    test('loads shared ESM fixture speech identical to Chromium helpers', () => {
        const result = runHelperProbe(`
fixture = load_article_selection_fixture()
print(json.dumps(fixture))
`);
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const fixture = JSON.parse(result.stdout.trim());
        const node = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(helperModule)}).href);
console.log(JSON.stringify({
    html: mod.buildArticleSelectionFixtureHtml(),
    speech: mod.ARTICLE_SELECTION_SPEECH,
}));
`], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
        expect(node.status).toBe(0);
        const chromium = JSON.parse(node.stdout.trim());
        expect(fixture.html).toBe(chromium.html);
        expect(fixture.speech).toEqual(chromium.speech);
        expect(fixture.html).toContain('id="selection-sentence"');
        expect(fixture.html).toContain('<article>');
    });

    test('rejects missing or colliding selection/article WAV hashes', () => {
        const result = runHelperProbe(`
ok = assert_distinct_article_selection_audio_hashes('aaa', 'bbb')
errors = []
for args in (('', 'bbb'), ('aaa', None), ('same', 'same')):
    try:
        assert_distinct_article_selection_audio_hashes(*args)
        errors.append('accepted:' + repr(args))
    except RuntimeError as exc:
        errors.append(str(exc))
print(json.dumps({'ok': ok, 'errors': errors}))
`);
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout.trim());
        expect(report.ok).toBe(true);
        expect(report.errors).toHaveLength(3);
        expect(report.errors[0]).toMatch(/missing/);
        expect(report.errors[1]).toMatch(/missing/);
        expect(report.errors[2]).toMatch(/collided/);
    });

    test('firefox live harness wires article/selection stage for ONNX origin', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toMatch(/from firefox_article_selection_acceptance import/);
        expect(source).toMatch(/origin_article_selection_stage_enabled\(/);
        expect(source).toMatch(/accept_real_article_and_selection\(/);
        expect(source).toMatch(/article_selection_acceptance/);
        expect(source).toMatch(/offline-real-article-and-selection/);
        expect(source).toMatch(/kokoro-float-btn/);
        expect(source).toMatch(/PARSE_ARTICLE/);
        expect(source).toMatch(/native-chromium-keys\.py/);
        expect(source).toMatch(/Alt_L/);
        const workflowSource = fs.readFileSync(workflow, 'utf8');
        expect(workflowSource).toMatch(/KOKORO_NATIVE_PYTHON/);
        expect(workflowSource).toMatch(/xvfb-run/);
        expect(workflowSource).toMatch(/test-native-chromium-dialog-key\.py/);
    });
});
