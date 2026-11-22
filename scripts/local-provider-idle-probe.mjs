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
    const waitForRelease = async () => {
        const waitStarted = performance.now();
        const deadline = Date.now() + 30000;
        while (manager.localProvider !== null) {
            if (Date.now() > deadline) throw Error('Local engine did not become idle');
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        await manager.localInferenceQueue; // Native close must have finished too.
        const observedMs = performance.now() - waitStarted;
        // Join after the configured idle timer — never invent negative latency.
        return Math.max(0, observedMs - configuredIdleMs);
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
    try {
        const firstUrl = await manager.getAudio(0);
        const firstProvider = manager.localProvider;
        if (!firstProvider) throw Error('Initial synthesis did not create a local provider');
        let closed = false;
        const nativeClose = firstProvider.close.bind(firstProvider);
        firstProvider.close = async () => { await nativeClose(); closed = true; };
        const before = await readWav(firstUrl);
        const idleReleaseJoinMs = await waitForRelease();
        const nativeReleased = backend === 'mediapipe'
            ? firstProvider.engine === null && firstProvider.modelUrl === null
            : firstProvider.session === null && firstProvider.voice === null;
        if (!closed || !nativeReleased) throw Error('Idle native close did not complete successfully');
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
        let closedAgain = false;
        const secondProvider = manager.localProvider;
        const secondClose = secondProvider.close.bind(secondProvider);
        secondProvider.close = async () => { await secondClose(); closedAgain = true; };
        await readWav(secondUrl);
        if (navigator.onLine !== false) throw Error('Idle recovery was not offline');
        const repeatedIdleReleaseJoinMs = await waitForRelease();
        if (!closedAgain) throw Error('Recreated provider did not complete idle teardown');
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
