/** @jest-environment node */
/**
 * Contract: Chromium live EPUB acceptance must accept both ONNX and
 * MediaPipe backends (chromium-onnx-origin / chromium-mediapipe-origin).
 */
const fs = require('fs');
const path = require('path');

describe('chromium EPUB acceptance backend wiring', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'validate-live-chromium.mjs'),
        'utf8',
    );

    test('acceptRealEpubReader takes an explicit backend argument', () => {
        expect(source).toMatch(
            /async function acceptRealEpubReader\(page, extensionId, backend\)/,
        );
        expect(source).toMatch(
            /EPUB reader acceptance requires onnx or mediapipe backend/,
        );
        expect(source).toMatch(/pendingTtsBackend === backend/);
        expect(source).toMatch(/selected !== backend/);
    });

    test('origin-download path runs EPUB for onnx and mediapipe', () => {
        expect(source).toMatch(
            /manifest\.provider === 'onnx' \|\| manifest\.provider === 'mediapipe'/,
        );
        expect(source).toMatch(
            /acceptRealEpubReader\(\s*page, extensionId, manifest\.provider\)/,
        );
        // Must not hard-gate the EPUB stage on onnx alone.
        expect(source).not.toMatch(
            /if \(originDownload && manifest\.provider === 'onnx' && result\.success\) \{\s*stage = 'offline-real-epub/,
        );
    });

    test('EPUB fixture uses nested TOC, distinct speech, and WAV hashes', () => {
        const fixture = fs.readFileSync(
            path.join(__dirname, '..', 'scripts', 'reader-acceptance-epub.mjs'),
            'utf8',
        );
        expect(source).toMatch(/from '\.\/reader-acceptance-epub\.mjs'/);
        expect(fixture).toContain("Hello first chapter.");
        expect(fixture).toContain("Hello first section.");
        expect(fixture).toContain("Hello second chapter.");
        expect(fixture).toContain("Hello third chapter.");
        expect(fixture).toContain("Hello plain text.");
        expect(fixture).toContain('first-section.xhtml');
        expect(fixture).toContain(
            '<ol><li><a href="first-section.xhtml">First Section</a></li></ol>',
        );
        expect(source).toMatch(/blocks\[0\]\.content === expectedSpeech/);
        expect(source).toMatch(/crypto\.subtle\.digest\('SHA-256'/);
        expect(source).toMatch(/differentAudioPerChapter = new Set\(\[/);
        expect(source).toMatch(/clickTocChapter\(\s*'First Section'\s*\)/);
        expect(source).toMatch(/assertFirstSectionNestedUnderFirstChapter/);
        expect(source).toMatch(/First Section not inside \.sub-items/);
        expect(source).toMatch(/waitForChapter\(\s*'First Section'/);
        expect(source).toMatch(/waitForChapter\(\s*'Third Chapter'/);
        expect(source).toMatch(/chapterCount: 4/);
        expect(source).toMatch(/READER_ACCEPTANCE_SPEECH\['First Section'\]/);
        expect(source).toMatch(/READER_ACCEPTANCE_SPEECH\['Third Chapter'\]/);
        expect(source).not.toMatch(
            /pendingContent\?\.some\(b => b\.content\?\.includes\('Hello world\.'\)\)/,
        );
    });
});

