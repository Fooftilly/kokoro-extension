/** @jest-environment node */
/**
 * Contract for Firefox long-form memory acceptance — keep shape distinct from
 * long-form-memory-acceptance.test.js (Chromium helper probe).
 * KE-52 walk + leave-open objective waveform quality measured; MOS unmeasured.
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
    LONG_FORM_QUALITY_MEASURED_NEEDLE,
    LONG_FORM_SENTENCE_COUNT,
    assert_bounded_audio_manager_stats,
    assert_long_form_cache_window_near,
    assert_long_form_heap_delta,
    decode_long_form_wav_pcm16_metrics,
    finalize_long_form_memory_acceptance_report,
    load_long_form_fixture,
    origin_long_form_memory_stage_enabled,
    require_long_form_backend,
    should_sample_long_form_waveform,
)
import subprocess

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
quality_samples = [
    {
        'index': i, 'audioBytes': 48000, 'sampleRateHz': 24000,
        'durationSec': 1.0, 'rms': 0.03 + (i * 0.001),
        'audioSha256': 'fx-' + str(i),
    }
    for i in (0, 6, 12, 35)
]
finalized = finalize_long_form_memory_acceptance_report({
    'success': True,
    'browser': 'Firefox',
    'backend': 'onnx',
    'maxCacheSize': 4,
    'samples': quality_samples,
})
visits = fixture['visits']
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
    'visits': visits,
    'visitEndsOnLast': (LONG_FORM_SENTENCE_COUNT - 1) in visits,
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
    'acceptMp': capture(lambda: require_long_form_backend('mediapipe')),
    'rejectRemote': capture(lambda: require_long_form_backend('remote')),
    'mpFixture': load_long_form_fixture('mediapipe')['storage'].get(
        'pendingTtsBackend'),
    'sampleGate': {
        'first': should_sample_long_form_waveform(0, visits),
        'mid': should_sample_long_form_waveform(6, visits),
        'skip': should_sample_long_form_waveform(7, visits),
        'lastVisit': should_sample_long_form_waveform(visits[-1], visits),
    },
    # Compact honesty gate — shape distinct from Chromium Jest expects so
    # Sonar new-code duplication stays under the ≤3% gate.
    'honestyGate': {
        'walk': finalized.get('sentenceCount'),
        'qualityOn': finalized.get('longFormQualityMeasured') is True,
        'mosOff': finalized.get('longFormMosMeasured') is False,
        'needleHit': LONG_FORM_QUALITY_MEASURED_NEEDLE in str(
            finalized.get('longFormQualityDisclosure') or ''),
        'sampleCount': finalized.get('qualitySampleCount'),
        'finalizeBlocksMos': not capture(
            lambda: finalize_long_form_memory_acceptance_report({
                'success': True, 'longFormMosMeasured': True,
                'samples': quality_samples,
            }))['ok'],
        'finalizeNeedsSamples': not capture(
            lambda: finalize_long_form_memory_acceptance_report({
                'success': True,
            }))['ok'],
        'repeatPadBlocked': not capture(
            lambda: finalize_long_form_memory_acceptance_report({
                'success': True,
                'samples': [
                    {**quality_samples[0], 'index': 0, 'rms': 0.03 + i * 0.001}
                    for i in range(4)
                ],
            }))['ok'],
    },
    # Real PCM16 WAV: ESM builder → base64 → Firefox decode bridge (1s=48000).
    'decoded': (lambda m: {
        'audioBytes': m.get('audioBytes'),
        'durationSec': m.get('durationSec'),
        'sampleRateHz': m.get('sampleRateHz'),
        'oneSecond': m.get('audioBytes') == 48000 and m.get('durationSec') == 1,
        'rmsOk': isinstance(m.get('rms'), (int, float)) and m['rms'] > 0.0001,
    })(decode_long_form_wav_pcm16_metrics(
        subprocess.check_output([
            'node', '--input-type=module', '-e',
            "import { buildLongFormTestWavPcm16 }"
            " from './long-form-memory-acceptance.mjs';"
            "process.stdout.write(Buffer.from("
            "buildLongFormTestWavPcm16(24000)).toString('base64'));",
        ], cwd=${JSON.stringify(scriptsDir)}).decode('ascii')
    )),
}))
`], { encoding: 'utf8', cwd: root });
}

describe('firefox long-form memory acceptance', () => {
    test('python helper snapshot covers gates, fixture, and quality', () => {
        const child = loadFirefoxLongFormSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.backends).toEqual(['mediapipe', 'onnx']);
        expect(snap.sentenceCount).toBe(36);
        expect(snap.bounds).toEqual({ cache: 8, urls: 8 });
        expect(snap.onnxRequired).toBe('onnx');
        expect(snap.probe).toBe(true);
        expect(snap.autoplayOff).toBe(true);
        expect(snap.pendingBackend).toBe('onnx');
        expect(snap.mpFixture).toBe('mediapipe');
        expect(snap.noSyncTts).toBe(true);
        expect(snap.storageKeys).toEqual(expect.arrayContaining([
            'pendingAcceptanceProbe', 'pendingContent', 'pendingTtsBackend',
        ]));
        expect(snap.visitEndsOnLast).toBe(false);
        expect(snap.visits[snap.visits.length - 1]).toBeLessThan(35);
        expect(snap.gates).toEqual({
            onnxOrigin: true,
            mediapipe: true,
            noOrigin: false,
            failedPrior: false,
        });
        expect(snap.statsOk.ok).toBe(true);
        expect(snap.windowOk.ok).toBe(true);
        expect(snap.windowFail.ok).toBe(false);
        expect(snap.cacheFail.ok).toBe(false);
        expect(snap.heapOk.growth).toBe(25);
        expect(snap.heapFail.ok).toBe(false);
        expect(snap.acceptMp.ok).toBe(true);
        expect(snap.rejectRemote.ok).toBe(false);
        expect(snap.sampleGate).toEqual({
            first: true, mid: true, skip: false, lastVisit: true,
        });
        expect(snap.honestyGate).toEqual({
            walk: 36,
            qualityOn: true,
            mosOff: true,
            needleHit: true,
            sampleCount: 4,
            finalizeBlocksMos: true,
            finalizeNeedsSamples: true,
            repeatPadBlocked: true,
        });
        expect(snap.decoded.oneSecond).toBe(true);
        expect(snap.decoded.sampleRateHz).toBe(24000);
        expect(snap.decoded.audioBytes).toBe(48000);
        expect(snap.decoded.durationSec).toBe(1);
        expect(snap.decoded.rmsOk).toBe(true);
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
        expect(source).toContain('finalize_long_form_memory_acceptance_report');
        expect(source).toContain('should_sample_long_form_waveform');
        expect(source).toContain('decode_long_form_wav_pcm16_metrics');
        expect(source).toContain('wavBase64');
        expect(source).not.toContain(
            'no subjective audio-quality or long-form acceptance');
        const helper = fs.readFileSync(
            path.join(scriptsDir, 'firefox_long_form_memory_acceptance.py'),
            'utf8');
        expect(helper).toContain('longFormStorageConfig');
        expect(helper).toContain('pendingAcceptanceProbe');
        expect(helper).toContain('LONG_FORM_SENTENCE_COUNT = 36');
        expect(helper).toContain('_invoke_long_form_esm');
        expect(helper).toContain('finalizeLongFormMemoryAcceptanceReport');
        expect(helper).toContain('should_sample_long_form_waveform');
        expect(helper).toContain('decode_long_form_wav_pcm16_metrics');
        expect(helper).toContain('decodeLongFormWavPcm16Metrics');
        expect(helper).toContain(
            'long-form objective waveform quality measured; MOS not measured');
        const workflowSource = fs.readFileSync(workflow, 'utf8');
        const firefoxJob = workflowSource.split('firefox-model-origin:')[1]
            ?.split(/\n {2}[a-z]/)[0] || '';
        expect(firefoxJob).toMatch(/timeout-minutes:\s*60\b/);
    });
});
