/** @jest-environment node */
/**
 * Contract: Firefox live EPUB acceptance must accept both ONNX and
 * MediaPipe backends (firefox-onnx-origin / firefox-mediapipe-origin).
 */
const fs = require('fs');
const path = require('path');

describe('firefox EPUB acceptance backend wiring', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'validate-live-firefox.py'),
        'utf8',
    );

    test('accept_real_epub_reader takes an explicit backend argument', () => {
        expect(source).toMatch(
            /def accept_real_epub_reader\(driver, origin, backend\):/,
        );
        expect(source).toMatch(
            /EPUB reader acceptance requires onnx or mediapipe backend/,
        );
        expect(source).toMatch(/stored\.pendingTtsBackend === backend/);
        expect(source).toMatch(/latest\.pendingTtsBackend !== backend/);
        expect(source).toMatch(/_assert_reader_backend_unchanged\(driver, backend\)/);
    });

    test('origin-download path runs EPUB for onnx and mediapipe', () => {
        expect(source).toMatch(
            /origin_download and provider in \("onnx", "mediapipe"\)/,
        );
        expect(source).toMatch(
            /run_offline_epub_reader_acceptance\(\s*driver, state\["origin"\], result, provider\)/,
        );
        // Must not hard-gate the EPUB stage on onnx alone.
        expect(source).not.toMatch(
            /if origin_download and provider == "onnx" and metrics\.get\("success"\):\s*\n\s*epub_reader_acceptance = run_offline_epub_reader_acceptance/,
        );
    });

    test('EPUB fixture uses shared speech map and WAV content hashes', () => {
        const fixture = fs.readFileSync(
            path.join(__dirname, '..', 'scripts', 'reader_acceptance_epub.py'),
            'utf8',
        );
        expect(fixture).toContain('Hello first chapter.');
        expect(fixture).toContain('Hello second chapter.');
        expect(fixture).toContain('Hello plain text.');
        expect(source).toMatch(/blocks\[0\]\.content === expectedSpeech/);
        expect(source).toMatch(/crypto\.subtle\.digest\('SHA-256'/);
        expect(source).toMatch(/different_audio = len\(\{/);
        expect(source).not.toMatch(
            /pendingContent\?\.some\(b => b\.content\?\.includes\('Hello world\.'\)\)/,
        );
    });
});
