// Serialized into both real extension pages by the opt-in browser harnesses.
// The shorter configured interval exercises the real timer and official native
// teardown without adding five minutes to each provider/browser acceptance run.
export async function probeLocalProviderIdleRelease({ backend, apiName }) {
    if (!['mediapipe', 'onnx'].includes(backend)) throw Error('Local backend required');
    const { AudioManager } = await import('./audio-manager.js');
    const api = globalThis[apiName];
    await api.storage.local.set({ pendingTtsBackend: backend, pendingApiUrl: '' });
    const configuredIdleMs = 100;
    const manager = new AudioManager({ localProviderIdleMs: configuredIdleMs });
    manager.setSentences([{ text: 'Hello world.' }, { text: 'Hello again.' }]);
    const unpin = manager.pinAudio(0);

    const nativeRefsReleased = (provider) => backend === 'mediapipe'
        ? provider.engine === null && provider.modelUrl === null
        : provider.session === null && provider.voice === null;

    // Join latency is native close() wall time — not idle-timer arithmetic.
    // AudioManager may arm the idle timer before WAV readback finishes, so
    // subtracting configuredIdleMs from a late waitStarted understates teardown.
    const instrumentCloseJoin = (provider) => {
        let closed = false;
        let joinMs = null;
        const nativeClose = provider.close.bind(provider);
        provider.close = async () => {
            const startedAt = performance.now();
            try {
                await nativeClose();
            } finally {
                joinMs = performance.now() - startedAt;
                closed = true;
            }
        };
        return {
            get closed() { return closed; },
            get joinMs() { return joinMs; },
        };
    };

    const waitForRelease = async () => {
        const deadline = Date.now() + 30000;
        while (manager.localProvider !== null) {
            if (Date.now() > deadline) throw Error('Local engine did not become idle');
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        await manager.localInferenceQueue; // Native close must have finished too.
    };

    const readWav = async url => {
        if (!url.startsWith('blob:')) throw Error('Expected locally generated Blob URL');
        const response = await fetch(url);
        if (!response.ok) throw Error('Cached audio URL no longer readable');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length < 46) throw Error('Empty local WAV');
        const h = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
            String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE' ||
            h.getUint32(24, true) !== 24000 ||
            h.getUint32(40, true) !== bytes.length - 44) {
            throw Error('Invalid local 24-kHz WAV after idle release');
        }
        return bytes;
    };

    const requireMeasuredJoin = (instrument, label) => {
        if (!instrument.closed) throw Error(label + ' did not complete idle teardown');
        if (!Number.isFinite(instrument.joinMs) || instrument.joinMs < 0) {
            throw Error(label + ' idleReleaseJoinMs invalid: ' + instrument.joinMs);
        }
        return instrument.joinMs;
    };

    try {
        const firstUrl = await manager.getAudio(0);
        const firstProvider = manager.localProvider;
        if (!firstProvider) throw Error('Initial synthesis did not create a local provider');
        const firstClose = instrumentCloseJoin(firstProvider);
        const before = await readWav(firstUrl);
        await waitForRelease();
        const idleReleaseJoinMs = requireMeasuredJoin(firstClose, 'First idle close');
        if (!nativeRefsReleased(firstProvider)) {
            throw Error('Idle native close did not clear model references');
        }
        const cachedUrl = await manager.getAudio(0);
        const after = await readWav(cachedUrl);
        if (cachedUrl !== firstUrl || before.length !== after.length ||
            !before.every((byte, i) => byte === after[i]) || manager.localProvider !== null) {
            throw Error('Idle release changed cached audio or reloaded the engine for a cache hit');
        }
        const secondUrl = await manager.getAudio(1);
        if (!manager.localProvider || manager.localProvider === firstProvider) {
            throw Error('New synthesis did not reconstruct the released provider');
        }
        const secondProvider = manager.localProvider;
        const secondClose = instrumentCloseJoin(secondProvider);
        await readWav(secondUrl);
        if (navigator.onLine !== false) throw Error('Idle recovery was not offline');
        await waitForRelease();
        const repeatedIdleReleaseJoinMs = requireMeasuredJoin(
            secondClose, 'Repeated idle close');
        if (!nativeRefsReleased(secondProvider)) {
            throw Error('Repeated idle close did not clear model references');
        }
        return {
            success: true, backend, configuredIdleMs,
            idleReleaseJoinMs, repeatedIdleReleaseJoinMs,
            nativeModelReferencesReleased: true,
            cachedAudioPreservedByteForByte: true,
            cachedReplayDidNotReloadModel: true,
            freshProviderSynthesizedAfterIdle: true,
            repeatedIdleRelease: true, sampleRateHz: 24000, offline: true,
        };
    } finally {
        unpin();
        manager.clear();
        await waitForRelease();
    }
}
