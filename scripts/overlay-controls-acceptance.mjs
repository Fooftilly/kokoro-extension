/**
 * Shared overlay controls acceptance helpers (#57).
 * ONNX includes unsupported-word Retry; MediaPipe covers nav/settings/play-pause.
 */

export const ALLOWED_OVERLAY_BACKENDS = Object.freeze(['onnx', 'mediapipe']);

export function overlaySeedForBackend(backend, { includeUnsupported = false } = {}) {
    if (!ALLOWED_OVERLAY_BACKENDS.includes(backend)) {
        throw new Error('Unsupported overlay acceptance backend: ' + backend);
    }
    const third = includeUnsupported ? 'zzzzqwertyword.' : 'Hello again.';
    return {
        pendingTtsBackend: backend,
        pendingApiUrl: null,
        pendingText: `Hello world. Hello world. ${third}`,
        pendingContent: [
            { type: 'text', content: 'Hello world.' },
            { type: 'text', content: 'Hello world.' },
            { type: 'text', content: third },
        ],
        pendingTitle: `${backend} overlay acceptance`,
        pendingAutoplay: false,
    };
}

export function assertOverlayWavSnapshot(snap) {
    if (!snap || typeof snap !== 'object') {
        throw new Error('Overlay WAV snapshot missing: ' + String(snap));
    }
    if (snap.sampleRateHz !== 24000) {
        throw new Error('Overlay WAV sample rate mismatch: ' + snap.sampleRateHz);
    }
    if (!(snap.audioBytes > 1)) {
        throw new Error('Overlay WAV audioBytes too small: ' + snap.audioBytes);
    }
    if (snap.initiallyPaused !== true) {
        throw new Error('Overlay must start paused with autoplay disabled');
    }
    return true;
}

export function assertOverlaySettings(settings) {
    if (!settings || typeof settings !== 'object') {
        throw new Error('Overlay settings missing: ' + String(settings));
    }
    if (Math.abs(settings.rate - 1.25) > 0.001 ||
        Math.abs(settings.volume - 0.4) > 0.001 ||
        settings.paused !== true) {
        throw new Error('Overlay speed/volume/paused mismatch: ' +
            JSON.stringify(settings));
    }
    return true;
}

export function buildOverlayControlsReport(options = {}) {
    const backend = options.backend || 'unknown';
    const includeRetry = options.includeRetry === true;
    const controls = includeRetry
        ? ['next', 'previous', 'speed', 'volume', 'play-pause', 'retry-after-error']
        : ['next', 'previous', 'speed', 'volume', 'play-pause'];
    return {
        success: true,
        backend,
        sentences: 3,
        initiallyPaused: true,
        playPauseToggled: options.playPauseToggled === true,
        unsupportedSentenceRejected: includeRetry
            ? options.unsupportedSentenceRejected === true
            : false,
        retryRestoredAudio: includeRetry
            ? options.retryRestoredAudio === true
            : false,
        retryNotApplicable: !includeRetry,
        sampleRateHz: options.sampleRateHz || 24000,
        audioBytes: options.audioBytes || 0,
        controls,
        rate: options.rate,
        volume: options.volume,
        networkOffline: true,
    };
}
