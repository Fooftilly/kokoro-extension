/** @jest-environment node */
/**
 * Contract checks for Firefox article/selection acceptance — keep this file's
 * shape distinct from article-selection-acceptance.test.js (Sonar new-code
 * duplication on the Chromium helper probe).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');
const firefoxLive = path.join(scriptsDir, 'validate-live-firefox.py');
const workflow = path.join(
    root, '.github', 'workflows', 'live-browser-acceptance.yml');

function loadFirefoxArticleSnapshot() {
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

def capture(fn):
    try:
        return {'ok': True, 'value': fn()}
    except Exception as exc:
        return {'ok': False, 'message': str(exc)}

fixture = load_article_selection_fixture()
speech = fixture['speech']
storage = article_selection_storage_config('onnx')
print(json.dumps({
    'backends': sorted(ALLOWED_ARTICLE_SELECTION_BACKENDS),
    'onnxRequired': require_article_selection_backend('onnx'),
    'storageKeys': sorted(storage.keys()),
    'ttsBackend': storage['ttsBackend'],
    'floatingMic': storage['showFloatingButton'] is True,
    'streamMode': storage['mode'] == 'stream',
    'emptyApi': storage['apiUrl'] == '',
    'fixtureHasSelectionId': 'id="selection-sentence"' in fixture['html'],
    'fixtureHasArticleTag': '<article>' in fixture['html'],
    'selectionSpeech': speech['selection'],
    'articlePair': [speech['articleFirst'], speech['articleSecond']],
    'speechDistinct': len({
        speech['selection'], speech['articleFirst'], speech['articleSecond'],
    }) == 3,
    'gates': {
        'onnxOrigin': origin_article_selection_stage_enabled(True, 'onnx', True),
        'mediapipe': origin_article_selection_stage_enabled(True, 'mediapipe', True),
        'noOrigin': origin_article_selection_stage_enabled(False, 'onnx', True),
        'failedPrior': origin_article_selection_stage_enabled(True, 'onnx', False),
    },
    'hashOk': capture(
        lambda: assert_distinct_article_selection_audio_hashes('aaa', 'bbb')),
    'hashMissing': capture(
        lambda: assert_distinct_article_selection_audio_hashes('', 'bbb')),
    'hashCollision': capture(
        lambda: assert_distinct_article_selection_audio_hashes('same', 'same')),
    'rejectMediapipe': capture(
        lambda: require_article_selection_backend('mediapipe')),
}))
`], { encoding: 'utf8', cwd: root });
}

describe('firefox article/selection acceptance', () => {
    test('python helper snapshot covers gates, fixture speech, and hashes', () => {
        const child = loadFirefoxArticleSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.backends).toEqual(['onnx']);
        expect(snap.onnxRequired).toBe('onnx');
        expect(snap.ttsBackend).toBe('onnx');
        expect(snap.floatingMic).toBe(true);
        expect(snap.streamMode).toBe(true);
        expect(snap.emptyApi).toBe(true);
        expect(snap.storageKeys).toEqual(expect.arrayContaining([
            'apiUrl', 'mode', 'showFloatingButton', 'ttsBackend',
        ]));
        expect(snap.fixtureHasSelectionId).toBe(true);
        expect(snap.fixtureHasArticleTag).toBe(true);
        expect(snap.speechDistinct).toBe(true);
        expect(snap.selectionSpeech).toMatch(/Hello/);
        expect(snap.articlePair[0]).not.toBe(snap.articlePair[1]);
        expect(snap.gates).toEqual({
            onnxOrigin: true,
            mediapipe: false,
            noOrigin: false,
            failedPrior: false,
        });
        expect(snap.hashOk.ok).toBe(true);
        expect(snap.hashMissing.ok).toBe(false);
        expect(snap.hashMissing.message).toMatch(/missing/);
        expect(snap.hashCollision.ok).toBe(false);
        expect(snap.hashCollision.message).toMatch(/collided/);
        expect(snap.rejectMediapipe.ok).toBe(false);
        expect(snap.rejectMediapipe.message).toMatch(/onnx/);
    });

    test('shared ESM fixture matches the python-loaded html bytes', () => {
        const py = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
from firefox_article_selection_acceptance import load_article_selection_fixture
print(json.dumps(load_article_selection_fixture()))
`], { encoding: 'utf8', cwd: root });
        expect(py.status).toBe(0);
        const fromPy = JSON.parse(py.stdout.trim());
        const node = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(
    ${JSON.stringify(path.join(scriptsDir, 'article-selection-acceptance.mjs'))}
).href);
console.log(JSON.stringify({
    html: mod.buildArticleSelectionFixtureHtml(),
    speech: mod.ARTICLE_SELECTION_SPEECH,
}));
`], { encoding: 'utf8', cwd: root });
        expect(node.status).toBe(0);
        const fromNode = JSON.parse(node.stdout.trim());
        expect(fromPy.html).toBe(fromNode.html);
        expect(fromPy.speech).toEqual(fromNode.speech);
    });

    test('firefox live harness and workflow wire Alt+A article stage', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toContain('firefox_article_selection_acceptance');
        expect(source).toContain('origin_article_selection_stage_enabled');
        expect(source).toContain('accept_real_article_and_selection');
        expect(source).toContain('offline-real-article-and-selection');
        expect(source).toContain('kokoro-float-btn');
        expect(source).toContain('PARSE_ARTICLE');
        expect(source).toContain('from native_chromium_x11 import X11Session');
        expect(source).toContain('focus_name_substr="Firefox"');
        expect(source).toContain('findArticleFixtureTab');
        expect(source).toContain("http://127.0.0.1/*");
        expect(source).toContain('Alt_L');
        expect(source).not.toContain('subprocess.check_output');
        expect(source).not.toContain('tabs.query({ url: fixtureUrl })');
        const x11 = fs.readFileSync(
            path.join(scriptsDir, 'native_chromium_x11.py'), 'utf8');
        expect(x11).toContain('def focus_client_window');
        expect(x11).toContain('XSetInputFocus');
        const workflowSource = fs.readFileSync(workflow, 'utf8');
        expect(workflowSource).toContain('KOKORO_NATIVE_PYTHON');
        expect(workflowSource).toContain('xvfb-run');
        expect(workflowSource).toContain('test-native-chromium-dialog-key.py');
    });
});
