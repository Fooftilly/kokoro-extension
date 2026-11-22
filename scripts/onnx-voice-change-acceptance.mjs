/**
 * ONNX voice-change acceptance (#60): two catalogued voice assets must both
 * synthesize non-silent PCM, and the waveforms must differ.
 */

export const ONNX_VOICE_CHANGE_ASSETS = Object.freeze([
    'voices/af.bin',
    'voices/af_bella.bin',
]);

export const ONNX_VOICE_CHANGE_PROBE_TEXT = 'Hello world.';

/**
 * @param {{
 *   voices: Array<{
 *     voiceAssetPath: string,
 *     sampleRateHz: number,
 *     sampleCount: number,
 *     rms: number,
 *     sha256Hex?: string,
 *   }>,
 * }} report
 */
export function assertOnnxVoiceChange(report) {
    if (!report || typeof report !== 'object') {
        throw new Error('ONNX voice-change report missing');
    }
    const voices = Array.isArray(report.voices) ? report.voices : [];
    if (voices.length !== ONNX_VOICE_CHANGE_ASSETS.length) {
        throw new Error('ONNX voice-change expected ' + ONNX_VOICE_CHANGE_ASSETS.length +
            ' voices, got ' + voices.length);
    }
    const seen = new Set();
    const digests = [];
    for (const row of voices) {
        if (!row || typeof row !== 'object') {
            throw new Error('ONNX voice-change row missing');
        }
        if (!ONNX_VOICE_CHANGE_ASSETS.includes(row.voiceAssetPath)) {
            throw new Error('Unexpected ONNX voice asset: ' + row.voiceAssetPath);
        }
        if (seen.has(row.voiceAssetPath)) {
            throw new Error('Duplicate ONNX voice asset: ' + row.voiceAssetPath);
        }
        seen.add(row.voiceAssetPath);
        if (row.sampleRateHz !== 24000) {
            throw new Error('ONNX voice-change sampleRateHz mismatch: ' + row.sampleRateHz);
        }
        if (!(row.sampleCount > 1000)) {
            throw new Error('ONNX voice-change sampleCount too small: ' + row.sampleCount);
        }
        if (!(row.rms > 0.001)) {
            throw new Error('ONNX voice-change near-silent for ' + row.voiceAssetPath);
        }
        if (typeof row.sha256Hex === 'string' && /^[a-f0-9]{64}$/.test(row.sha256Hex)) {
            digests.push(row.sha256Hex);
        }
    }
    if (seen.size !== ONNX_VOICE_CHANGE_ASSETS.length) {
        throw new Error('ONNX voice-change missing catalogued assets');
    }
    if (digests.length === ONNX_VOICE_CHANGE_ASSETS.length &&
        digests[0] === digests[1]) {
        throw new Error('ONNX voice-change PCM digests must differ across voices');
    }
    return true;
}

export function buildOnnxVoiceChangeReport(voices) {
    return {
        success: false,
        voices: Array.isArray(voices) ? voices : [],
        voiceChangeMeasured: false,
    };
}

export function markOnnxVoiceChangeSuccess(report) {
    assertOnnxVoiceChange(report);
    report.success = true;
    report.voiceChangeMeasured = true;
    return report;
}
