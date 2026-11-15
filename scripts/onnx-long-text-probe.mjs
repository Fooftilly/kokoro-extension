// Runs in the packaged extension, with the actual cached ONNX model and WAV
// player route. Serialized unchanged into Chromium and Firefox by the harness.
export async function probeOnnxLongText({ apiName }) {
    const { AudioManager } = await import('./audio-manager.js');
    const { tokenizePhonemes, MAX_PHONEMES } = await import('./phoneme-tokenizer.js');
    const { encodePcm16Wav } = await import('./pcm-wav.js');
    const api = globalThis[apiName];
    await api.storage.local.set({ pendingTtsBackend: 'onnx', pendingApiUrl: '' });
    const longText = Array(74).fill('hello').join(' ') + '.';
    const manager = new AudioManager();
    manager.setSentences([
        { text: 'Hello world.' }, { text: longText },
        { text: longText }, { text: 'Hello again.' },
    ]);
    const readWavBytes = async url => {
        if (!url.startsWith('blob:')) throw Error('ONNX long text did not create a local Blob');
        const response = await fetch(url);
        if (!response.ok) throw Error('ONNX long-text WAV URL unavailable');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length < 46) throw Error('Empty ONNX long-text WAV');
        const h = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const dataBytes = h.getUint32(40, true);
        if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
            String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE' ||
            h.getUint32(24, true) !== 24000 || dataBytes !== bytes.length - 44) {
            throw Error('Invalid ONNX long-text 24-kHz WAV');
        }
        return bytes;
    };
    try {
        await manager.getAudio(0);
        const provider = manager.localProvider;
        const nativeSession = provider.session;
        const original = provider.synthesizePhonemes.bind(provider);
        const completedChunks = [];
        const expectedPcm = [];
        provider.synthesizePhonemes = async (phonemes, options) => {
            const output = await original(phonemes, options);
            const detail = { tokens: tokenizePhonemes(phonemes).length, samples: output.samples.length };
            completedChunks.push(detail);
            expectedPcm.push(encodePcm16Wav(output.samples, output.sampleRateHz).subarray(44));
            // Report only completed real model work to Chromium's watchdog.
            await globalThis.__kokoroLongTextProgress?.(detail);
            return output;
        };
        const wav = await readWavBytes(await manager.getAudio(1));
        const audioBytes = wav.length - 44;
        if (completedChunks.length !== 2 || completedChunks[0].tokens !== MAX_PHONEMES ||
            completedChunks[1].tokens !== 7 ||
            completedChunks.reduce((sum, chunk) => sum + chunk.samples * 2, 0) !== audioBytes ||
            provider.session !== nativeSession) {
            throw Error('Long text lost chunks, exceeded graph bounds or replaced the warm session');
        }
        let offset = 44;
        for (const chunk of expectedPcm) {
            if (!chunk.every((byte, i) => wav[offset + i] === byte)) {
                throw Error('Combined WAV did not preserve native chunk PCM in order');
            }
            offset += chunk.length;
        }
        let cancelledChunks = 0;
        provider.synthesizePhonemes = async (phonemes, options) => {
            const output = await original(phonemes, options);
            cancelledChunks++;
            await provider.cancel(); // Actual cancellation at a completed native-run boundary.
            await globalThis.__kokoroLongTextProgress?.({ cancelledChunks });
            return output;
        };
        let cancellation = null;
        try { await manager.getAudio(2); } catch (error) { cancellation = error.name; }
        if (cancellation !== 'AbortError' || cancelledChunks !== 1 || manager.audioCache.has(2)) {
            throw Error('Cancelled long text produced audio or continued its remaining chunks');
        }
        provider.synthesizePhonemes = original;
        await readWavBytes(await manager.getAudio(3));
        if (provider.session !== nativeSession || navigator.onLine !== false) {
            throw Error('Post-cancel synthesis lost its warm session or offline execution');
        }
        return {
            success: true, words: 74, chunkTokens: completedChunks.map(chunk => chunk.tokens),
            audioBytes, sampleRateHz: 24000, oneWarmSession: true, orderedPcmVerified: true,
            cancelledAfterChunks: cancelledChunks, cancelledAudioDiscarded: true,
            nextSynthesisSucceeded: true, offline: true,
            perceptualQualityMeasured: false,
        };
    } finally {
        manager.clear();
        await manager.localInferenceQueue;
        if (manager.localProvider) await manager.localProvider.close();
    }
}
