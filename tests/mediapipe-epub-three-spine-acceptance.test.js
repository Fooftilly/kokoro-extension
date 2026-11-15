/** @jest-environment node */
/**
 * KE-50: MediaPipe origin EPUB must exercise the shared four-spine fixture
 * (Third Chapter + nested First Section + four distinct chapter WAV hashes) that KE-47 / #170 landed
 * for ONNX. Live path is shared acceptRealEpubReader / accept_real_epub_reader —
 * this contract fails closed if MediaPipe origin drops Third Chapter wiring.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');
const workflowPath = path.join(
    root, '.github', 'workflows', 'live-browser-acceptance.yml');

function runHelperProbe(pythonSnippet) {
    return spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
from firefox_epub_acceptance import (
    ALLOWED_EPUB_BACKENDS,
    assert_distinct_chapter_audio_hashes,
    origin_epub_stage_enabled,
    require_epub_backend,
)
${pythonSnippet}
`], { encoding: 'utf8', cwd: root });
}

describe('MediaPipe origin three-spine EPUB acceptance (KE-50)', () => {
    test('allowlist and origin gate keep mediapipe on the EPUB stage', () => {
        const result = runHelperProbe(`
print(json.dumps({
    'allowed': sorted(ALLOWED_EPUB_BACKENDS),
    'required': require_epub_backend('mediapipe'),
    'stageOn': origin_epub_stage_enabled(True, 'mediapipe', True),
    'stageOffOrigin': origin_epub_stage_enabled(False, 'mediapipe', True),
    'stageOffSuccess': origin_epub_stage_enabled(True, 'mediapipe', False),
}))
`);
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const report = JSON.parse(result.stdout.trim());
        expect(report.allowed).toContain('mediapipe');
        expect(report.required).toBe('mediapipe');
        expect(report.stageOn).toBe(true);
        expect(report.stageOffOrigin).toBe(false);
        expect(report.stageOffSuccess).toBe(false);
    });

    test('four-spine hash helper rejects MediaPipe collisions and missing chapter', () => {
        const result = runHelperProbe(`
ok = assert_distinct_chapter_audio_hashes('mp1', 'mp-section', 'mp2', 'mp3', 'mptxt')
errors = []
for args in (
    ('mp1', 'mp-section', 'mp2', 'mp1', 'mptxt'),
    ('mp1', 'mp-section', 'mp2', None, 'mptxt'),
    ('a', 'b', 'c', 'd', 'a'),
):
    try:
        assert_distinct_chapter_audio_hashes(*args)
        errors.append('accepted:' + repr(args))
    except RuntimeError as exc:
        errors.append(str(exc))
print(json.dumps({'ok': ok, 'errors': errors}))
`);
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const report = JSON.parse(result.stdout.trim());
        expect(report.ok).toBe(true);
        expect(report.errors).toHaveLength(3);
        expect(report.errors.every(message =>
            message.includes('not distinct') || message.includes('missing'))).toBe(true);
        expect(report.errors.some(message => message.startsWith('accepted:'))).toBe(false);
    });

    test('Chromium mediapipe origin calls shared three-spine acceptRealEpubReader', () => {
        const source = fs.readFileSync(
            path.join(scriptsDir, 'validate-live-chromium.mjs'), 'utf8');
        // Origin stage includes mediapipe (not onnx-only).
        expect(source).toMatch(
            /manifest\.provider === 'onnx' \|\| manifest\.provider === 'mediapipe'/,
        );
        expect(source).toMatch(
            /acceptRealEpubReader\(\s*page, extensionId, manifest\.provider\)/,
        );
        // Shared reader navigates First Section and Third Chapter (four spines).
        expect(source).toMatch(/waitForChapter\(\s*'Third Chapter'/);
        expect(source).toMatch(/READER_ACCEPTANCE_SPEECH\['Third Chapter'\]/);
        expect(source).toMatch(/chapterCount: 4/);
        expect(source).toMatch(
            /differentAudioPerChapter = new Set\(\[\s*first\.audioSha256,\s*firstSection\.audioSha256,\s*second\.audioSha256,\s*third\.audioSha256,\s*plainText\.audioSha256,?\s*\]\)/,
        );
        expect(source).toMatch(/third:\s*\{\s*title: third\.title/);
        // Backend arg accepts mediapipe explicitly.
        expect(source).toMatch(
            /backend !== 'onnx' && backend !== 'mediapipe'/,
        );
    });

    test('Firefox mediapipe origin calls shared three-spine accept_real_epub_reader', () => {
        const source = fs.readFileSync(
            path.join(scriptsDir, 'validate-live-firefox.py'), 'utf8');
        const helper = fs.readFileSync(
            path.join(scriptsDir, 'firefox_epub_acceptance.py'), 'utf8');
        expect(helper).toContain('mediapipe');
        expect(helper).toMatch(/assert_distinct_chapter_audio_hashes/);
        expect(source).toMatch(/origin_epub_stage_enabled\(/);
        expect(source).toMatch(
            /run_offline_epub_reader_acceptance\(\s*driver, state\["origin"\], result, provider\)/,
        );
        expect(source).toContain('"Third Chapter"');
        expect(source).toContain('Hello third chapter.');
        expect(source).toContain('"chapterCount": 4');
        expect(source).toMatch(
            /assert_distinct_chapter_audio_hashes\(\s*first\["audioSha256"\],\s*first_section\["audioSha256"\],\s*second\["audioSha256"\],\s*third\["audioSha256"\],\s*plain_text\["audioSha256"\]\)/,
        );
        expect(source).toMatch(/"third":\s*\{\s*"title":\s*third\["title"\]/);
    });

    test('live workflow exposes chromium- and firefox-mediapipe-origin scopes', () => {
        const workflow = fs.readFileSync(workflowPath, 'utf8');
        expect(workflow).toContain('chromium-mediapipe-origin');
        expect(workflow).toContain('firefox-mediapipe-origin');
        expect(workflow).toMatch(
            /acceptance_scope == 'chromium-mediapipe-origin' && 'mediapipe'/,
        );
    });
});
