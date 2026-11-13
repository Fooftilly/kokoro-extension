/** @jest-environment node */
/**
 * Contract for Firefox long-form memory acceptance — keep shape distinct from
 * long-form-memory-acceptance.test.js (Chromium helper probe).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');
const firefoxLive = path.join(scriptsDir, 'validate-live-firefox.py');
const workflow = path.join(
    root, '.github', 'workflows', 'live-browser-acceptance.yml');

function loadFirefoxLongFormSnapshot() {
    return spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
from firefox_long_form_memory_acceptance import (
    ALLOWED_LONG_FORM_BACKENDS,
    LONG_FORM_MAX_CACHE_ENTRIES,
    LONG_FORM_MAX_OBJECT_URLS,
    LONG_FORM_SENTENCE_COUNT,
    assert_bounded_audio_manager_stats,
    assert_long_form_cache_window_near,
    assert_long_form_heap_delta,
    load_long_form_fixture,
    origin_long_form_memory_stage_enabled,
    require_long_form_backend,
)

def capture(fn):
    try:
        return {'ok': True, 'value': fn()}
    except Exception as exc:
        return {'ok': False, 'message': str(exc)}

fixture = load_long_form_fixture('onnx')
sample = {
    'cacheSize': 4,
    'objectUrlCount': 3,
    'sentenceCount': LONG_FORM_SENTENCE_COUNT,
    'window': {'first': 0, 'last': 4},
}
print(json.dumps({
    'backends': sorted(ALLOWED_LONG_FORM_BACKENDS),
    'sentenceCount': LONG_FORM_SENTENCE_COUNT,
    'bounds': {
        'cache': LONG_FORM_MAX_CACHE_ENTRIES,
        'urls': LONG_FORM_MAX_OBJECT_URLS,
    },
    'onnxRequired': require_long_form_backend('onnx'),
    'storageKeys': sorted(fixture['storage'].keys()),
    'probe': fixture['storage'].get('pendingAcceptanceProbe') is True,
    'autoplayOff': fixture['storage'].get('pendingAutoplay') is False,
    'pendingBackend': fixture['storage'].get('pendingTtsBackend'),
    'noSyncTts': 'ttsBackend' not in fixture['storage'],
    'visits': fixture['visits'],
    'visitEndsOnLast': (LONG_FORM_SENTENCE_COUNT - 1) in fixture['visits'],
    'gates': {
        'onnxOrigin': origin_long_form_memory_stage_enabled(True, 'onnx', True),
        'mediapipe': origin_long_form_memory_stage_enabled(True, 'mediapipe', True),
        'noOrigin': origin_long_form_memory_stage_enabled(False, 'onnx', True),
        'failedPrior': origin_long_form_memory_stage_enabled(True, 'onnx', False),
    },
    'statsOk': capture(lambda: assert_bounded_audio_manager_stats(sample)),
    'windowOk': capture(
        lambda: assert_long_form_cache_window_near(sample, 2)),
    'windowFail': capture(lambda: assert_long_form_cache_window_near(
        {**sample, 'window': {'first': 10, 'last': 14}}, 2)),
    'cacheFail': capture(lambda: assert_bounded_audio_manager_stats({
        **sample, 'cacheSize': LONG_FORM_MAX_CACHE_ENTRIES + 3,
    })),
    'heapOk': assert_long_form_heap_delta(50, 75),
    'heapFail': capture(
        lambda: assert_long_form_heap_delta(0, 300 * 1024 * 1024)),
    'rejectMp': capture(lambda: require_long_form_backend('mediapipe')),
}))
`], { encoding: 'utf8', cwd: root });
}

describe('firefox long-form memory acceptance', () => {
    test('python helper snapshot covers gates, fixture, and bounds', () => {
        const child = loadFirefoxLongFormSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.backends).toEqual(['onnx']);
        expect(snap.sentenceCount).toBe(24);
        expect(snap.bounds).toEqual({ cache: 8, urls: 8 });
        expect(snap.onnxRequired).toBe('onnx');
        expect(snap.probe).toBe(true);
        expect(snap.autoplayOff).toBe(true);
        expect(snap.pendingBackend).toBe('onnx');
        expect(snap.noSyncTts).toBe(true);
        expect(snap.storageKeys).toEqual(expect.arrayContaining([
            'pendingAcceptanceProbe', 'pendingContent', 'pendingTtsBackend',
        ]));
        expect(snap.visitEndsOnLast).toBe(false);
        expect(snap.visits[snap.visits.length - 1]).toBeLessThan(23);
        expect(snap.gates).toEqual({
            onnxOrigin: true,
            mediapipe: false,
            noOrigin: false,
            failedPrior: false,
        });
        expect(snap.statsOk.ok).toBe(true);
        expect(snap.windowOk.ok).toBe(true);
        expect(snap.windowFail.ok).toBe(false);
        expect(snap.cacheFail.ok).toBe(false);
        expect(snap.heapOk.growth).toBe(25);
        expect(snap.heapFail.ok).toBe(false);
        expect(snap.rejectMp.ok).toBe(false);
    });

    test('firefox live harness wires long-form stage after article/selection', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toContain('firefox_long_form_memory_acceptance');
        expect(source).toContain('origin_long_form_memory_stage_enabled');
        expect(source).toContain('accept_firefox_long_form_memory');
        expect(source).toContain('run_offline_long_form_memory_acceptance');
        expect(source).toContain('offline-real-long-form-memory');
        expect(source).toContain('longFormMemoryAcceptance');
        expect(source).toContain('__kokoroAudioManagerStats');
        expect(source).toContain('_jump_firefox_long_form_across_windows');
        expect(source).toContain('load_long_form_fixture');
        expect(source).not.toContain(
            'no subjective audio-quality or long-form acceptance');
        const helper = fs.readFileSync(
            path.join(scriptsDir, 'firefox_long_form_memory_acceptance.py'),
            'utf8');
        expect(helper).toContain('longFormStorageConfig');
        expect(helper).toContain('pendingAcceptanceProbe');
        const workflowSource = fs.readFileSync(workflow, 'utf8');
        const firefoxJob = workflowSource.split('firefox-model-origin:')[1]
            ?.split(/\n {2}[a-z]/)[0] || '';
        expect(firefoxJob).toMatch(/timeout-minutes:\s*60\b/);
    });
});
