// Original PCM-to-WAV serialization, shared by both local Kokoro engines.
// WAV 16-bit mono is widely playable in Firefox and Chrome without MP3 encoders.
//
// This validates basic PCM sanity, not perceptual sound quality or correct G2P.
// Calling it before enabling a backend prevents silent/corrupt mock-like output
// from being mistaken for working local speech.
// Firefox/SDK-generated typed arrays may originate in a different JS realm.
// The intrinsic ArrayBuffer.isView check is realm-independent; the intrinsic
// Float32 tag distinguishes 32-bit floating-point PCM from integer views.
function isFloat32Pcm(samples) {
    return ArrayBuffer.isView(samples) &&
        Object.prototype.toString.call(samples) === '[object Float32Array]';
}

export function validateKokoroPcm(samples, sampleRateHz) {
    if (!isFloat32Pcm(samples)) {
        throw new TypeError('Expected Kokoro Float32 PCM; received ' +
            Object.prototype.toString.call(samples));
    }
    if (sampleRateHz !== 24000) {
        throw new TypeError('Expected Kokoro 24-kHz PCM; received sampleRateHz=' +
            String(sampleRateHz));
    }
    if (samples.length === 0 || samples.length > sampleRateHz * 60 * 10) {
        throw new TypeError('Expected nonempty, bounded Kokoro 24-kHz Float32 PCM; length=' +
            String(samples.length));
    }
    let squares = 0;
    for (const sample of samples) {
        if (!Number.isFinite(sample)) throw new TypeError('PCM sample must be finite');
        squares += sample * sample;
    }
    const rms = Math.sqrt(squares / samples.length);
    if (!Number.isFinite(rms) || rms <= 0.0001) {
        throw new Error('Local Kokoro generated silent or near-silent PCM');
    }
    return { samples, sampleRateHz, rms };
}

export function encodePcm16Wav(samples, sampleRateHz = 24000) {
    if (!isFloat32Pcm(samples) || !Number.isInteger(sampleRateHz) ||
        sampleRateHz < 8000 || sampleRateHz > 192000 ||
        samples.length === 0 || samples.length > sampleRateHz * 60 * 10) {
        throw new TypeError('Expected a nonempty, bounded Float32Array and valid sample rate');
    }
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const text = (offset, value) => {
        for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRateHz, true);
    view.setUint32(28, sampleRateHz * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (!Number.isFinite(sample)) throw new TypeError('PCM sample must be finite');
        const clamped = Math.max(-1, Math.min(1, sample));
        view.setInt16(44 + i * 2,
            Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
    }
    return new Uint8Array(bytes);
}

export function pcmToWavBlob(samples, sampleRateHz = 24000) {
    return new Blob([encodePcm16Wav(samples, sampleRateHz)], { type: 'audio/wav' });
}
