/** @jest-environment node */
/**
 * Executable contract for Firefox EPUB/TXT acceptance routing helpers.
 * Exercises scripts/firefox_epub_acceptance.py — not source substrings —
 * so backend mis-wiring or duplicate-hash acceptance fails closed in Jest.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const scriptsDir = path.join(__dirname, '..', 'scripts');

function runHelperProbe(pythonSnippet) {
    const result = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
from firefox_epub_acceptance import (
    ALLOWED_EPUB_BACKENDS,
    assert_distinct_chapter_audio_hashes,
    epub_backend_variant,
    origin_epub_stage_enabled,
    reader_storage_config,
    require_epub_backend,
)
${pythonSnippet}
`], { encoding: 'utf8' });
    return result;
}

describe('firefox EPUB acceptance backend wiring', () => {
    test('routes onnx and mediapipe to distinct reader storage and variants', () => {
        const result = runHelperProbe(`
report = {
    'allowed': sorted(ALLOWED_EPUB_BACKENDS),
    'onnx': {
        'required': require_epub_backend('onnx'),
        'variant': epub_backend_variant('onnx'),
        'storage': reader_storage_config('onnx'),
    },
    'mediapipe': {
        'required': require_epub_backend('mediapipe'),
        'variant': epub_backend_variant('mediapipe'),
        'storage': reader_storage_config('mediapipe'),
    },
}
print(json.dumps(report))
`);
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const report = JSON.parse(result.stdout.trim());
        expect(report.allowed).toEqual(['mediapipe', 'onnx']);
        expect(report.onnx.required).toBe('onnx');
        expect(report.onnx.variant).toBe('onnx-q8');
        expect(report.onnx.storage.ttsBackend).toBe('onnx');
        expect(report.mediapipe.required).toBe('mediapipe');
        expect(report.mediapipe.variant).toBe('mediapipe-cpu');
        expect(report.mediapipe.storage.ttsBackend).toBe('mediapipe');
        expect(report.mediapipe.storage.ttsBackend)
            .not.toBe(report.onnx.storage.ttsBackend);
        expect(report.mediapipe.storage.mediaPipeVariant).toBe('cpu');
        expect(report.onnx.storage.autoplayReader).toBe(false);
    });

    test('rejects unsupported backends and keeps origin EPUB stage gated', () => {
        const result = runHelperProbe(`
errors = []
for bad in ('fastapi', 'dictionary', '', None):
    try:
        require_epub_backend(bad)
        errors.append('accepted:' + repr(bad))
    except ValueError as exc:
        errors.append(str(exc))
    try:
        epub_backend_variant(bad)
        errors.append('variant-accepted:' + repr(bad))
    except (ValueError, TypeError) as exc:
        errors.append('variant:' + str(exc))
    try:
        reader_storage_config(bad)
        errors.append('storage-accepted:' + repr(bad))
    except (ValueError, TypeError) as exc:
        errors.append('storage:' + str(exc))
print(json.dumps({
    'errors': errors,
    'onnxOn': origin_epub_stage_enabled(True, 'onnx', True),
    'mediapipeOn': origin_epub_stage_enabled(True, 'mediapipe', True),
    'onnxOffOrigin': origin_epub_stage_enabled(False, 'onnx', True),
    'onnxOffFail': origin_epub_stage_enabled(True, 'onnx', False),
    'dictionaryOff': origin_epub_stage_enabled(True, 'dictionary', True),
}))
`);
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const report = JSON.parse(result.stdout.trim());
        expect(report.errors.every(message =>
            message.includes('requires onnx or mediapipe') ||
            message.startsWith('variant:') ||
            message.startsWith('storage:'))).toBe(true);
        expect(report.errors.some(message => message.startsWith('accepted:'))).toBe(false);
        expect(report.onnxOn).toBe(true);
        expect(report.mediapipeOn).toBe(true);
        expect(report.onnxOffOrigin).toBe(false);
        expect(report.onnxOffFail).toBe(false);
        expect(report.dictionaryOff).toBe(false);
    });

    test('rejects missing or colliding chapter WAV content hashes', () => {
        const result = runHelperProbe(`
ok = assert_distinct_chapter_audio_hashes('aaa', 'bbb', 'ccc')
dup_errors = []
for args in (
    ('same', 'same', 'other'),
    ('a', 'b', 'a'),
    ('x', 'x', 'x'),
    ('only', 'two', None),
    ('', 'bbb', 'ccc'),
):
    try:
        assert_distinct_chapter_audio_hashes(*args)
        dup_errors.append('accepted:' + repr(args))
    except RuntimeError as exc:
        dup_errors.append(str(exc))
print(json.dumps({'ok': ok, 'dupErrors': dup_errors}))
`);
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const report = JSON.parse(result.stdout.trim());
        expect(report.ok).toBe(true);
        expect(report.dupErrors).toHaveLength(5);
        expect(report.dupErrors.every(message =>
            message.includes('not distinct') || message.includes('missing'))).toBe(true);
        expect(report.dupErrors.some(message => message.startsWith('accepted:'))).toBe(false);
    });
});
