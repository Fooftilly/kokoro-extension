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
});
