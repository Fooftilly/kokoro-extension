/** @jest-environment node */
/**
 * ONNX voice-change acceptance contract (#60).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'onnx-voice-change-acceptance.mjs')).href;

function runHelper(snippet) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as voice from ${JSON.stringify(helperUrl)};
${snippet}
`], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || 'helper failed');
    }
    return result.stdout.trim();
}

describe('ONNX voice-change acceptance (#60)', () => {
    test('requires two distinct non-silent catalogued voices', () => {
        const out = runHelper(`
const report = voice.buildOnnxVoiceChangeReport([
    {
        voiceAssetPath: 'voices/af.bin',
        sampleRateHz: 24000,
        sampleCount: 48000,
        rms: 0.04,
        sha256Hex: 'a'.repeat(64),
    },
    {
        voiceAssetPath: 'voices/af_bella.bin',
        sampleRateHz: 24000,
        sampleCount: 48000,
        rms: 0.05,
        sha256Hex: 'b'.repeat(64),
    },
]);
voice.markOnnxVoiceChangeSuccess(report);
process.stdout.write(JSON.stringify({
    success: report.success,
    voiceChangeMeasured: report.voiceChangeMeasured,
}));
`);
        expect(JSON.parse(out)).toEqual({
            success: true,
            voiceChangeMeasured: true,
        });
    });

    test('fails closed on identical digests or silence', () => {
        const identical = runHelper(`
try {
    voice.assertOnnxVoiceChange({
        voices: [
            {
                voiceAssetPath: 'voices/af.bin',
                sampleRateHz: 24000,
                sampleCount: 48000,
                rms: 0.04,
                sha256Hex: 'a'.repeat(64),
            },
            {
                voiceAssetPath: 'voices/af_bella.bin',
                sampleRateHz: 24000,
                sampleCount: 48000,
                rms: 0.04,
                sha256Hex: 'a'.repeat(64),
            },
        ],
    });
    process.stdout.write('pass');
} catch (error) {
    process.stdout.write(String(error.message || error));
}
`);
        expect(identical).toMatch(/differ/);

        const silent = runHelper(`
try {
    voice.assertOnnxVoiceChange({
        voices: [
            {
                voiceAssetPath: 'voices/af.bin',
                sampleRateHz: 24000,
                sampleCount: 48000,
                rms: 0,
                sha256Hex: 'a'.repeat(64),
            },
            {
                voiceAssetPath: 'voices/af_bella.bin',
                sampleRateHz: 24000,
                sampleCount: 48000,
                rms: 0.05,
                sha256Hex: 'b'.repeat(64),
            },
        ],
    });
    process.stdout.write('pass');
} catch (error) {
    process.stdout.write(String(error.message || error));
}
`);
        expect(silent).toMatch(/near-silent/);
    });

    test('rejects missing or malformed PCM digests', () => {
        const missing = runHelper(`
try {
    voice.assertOnnxVoiceChange({
        voices: [
            {
                voiceAssetPath: 'voices/af.bin',
                sampleRateHz: 24000,
                sampleCount: 48000,
                rms: 0.04,
                sha256Hex: 'a'.repeat(64),
            },
            {
                voiceAssetPath: 'voices/af_bella.bin',
                sampleRateHz: 24000,
                sampleCount: 48000,
                rms: 0.05,
            },
        ],
    });
    process.stdout.write('pass');
} catch (error) {
    process.stdout.write(String(error.message || error));
}
`);
        expect(missing).toMatch(/sha256Hex/);

        const malformed = runHelper(`
try {
    voice.assertOnnxVoiceChange({
        voices: [
            {
                voiceAssetPath: 'voices/af.bin',
                sampleRateHz: 24000,
                sampleCount: 48000,
                rms: 0.04,
                sha256Hex: 'not-a-digest',
            },
            {
                voiceAssetPath: 'voices/af_bella.bin',
                sampleRateHz: 24000,
                sampleCount: 48000,
                rms: 0.05,
                sha256Hex: 'b'.repeat(64),
            },
        ],
    });
    process.stdout.write('pass');
} catch (error) {
    process.stdout.write(String(error.message || error));
}
`);
        expect(malformed).toMatch(/sha256Hex/);
    });

    test('live harnesses import the shared acceptance module', () => {
        const chromium = fs.readFileSync(
            path.join(root, 'scripts', 'validate-live-chromium.mjs'), 'utf8');
        const firefox = fs.readFileSync(
            path.join(root, 'scripts', 'validate-live-firefox.py'), 'utf8');
        expect(chromium).toContain('onnx-voice-change-acceptance.mjs');
        expect(chromium).toContain('offline-onnx-voice-change');
        expect(chromium).toContain('online-optional-onnx-voice-install');
        expect(chromium).toMatch(
            /online-optional-onnx-voice-install[\s\S]*setOffline\(true\)/);
        expect(firefox).toContain('onnx-voice-change-acceptance.mjs');
        expect(firefox).toContain('offline-onnx-voice-change');
        expect(firefox).toContain('online-optional-onnx-voice-install');
        expect(firefox).toMatch(
            /online-optional-onnx-voice-install[\s\S]*Services\.io\.offline = true/);
    });
});
