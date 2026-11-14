/**
 * Chromium live acceptance report shapes for mid-stage diagnostics.
 * Intermediate saves carry currentProvider until results[] is finalized.
 */

export function buildCurrentProviderSnapshot({
    provider,
    variant,
    stage,
    crashed = false,
    originModelAcceptance = null,
    onnxPlaybackAcceptance = null,
    onnxOverlayAcceptance = null,
    mediapipeOverlayAcceptance = null,
    localBenchmarkAcceptance = null,
    epubReaderAcceptance = null,
    articleSelectionAcceptance = null,
    longFormMemoryAcceptance = null,
} = {}) {
    if (typeof provider !== 'string' || !provider) {
        throw new Error('currentProvider snapshot requires provider');
    }
    if (typeof variant !== 'string' || !variant) {
        throw new Error('currentProvider snapshot requires variant');
    }
    if (typeof stage !== 'string' || !stage) {
        throw new Error('currentProvider snapshot requires stage');
    }
    return {
        provider,
        variant,
        stage,
        crashed: crashed === true,
        originModelAcceptance,
        onnxPlaybackAcceptance,
        onnxOverlayAcceptance,
        mediapipeOverlayAcceptance,
        localBenchmarkAcceptance,
        epubReaderAcceptance,
        articleSelectionAcceptance,
        longFormMemoryAcceptance,
    };
}

/** Mid-provider stall artifact: completed checks live on currentProvider. */
export function assertIntermediateLiveReport(report, expected = {}) {
    if (!report || typeof report !== 'object') {
        throw new Error('Live report missing: ' + String(report));
    }
    if (!Array.isArray(report.results)) {
        throw new Error('Live report results must be an array');
    }
    const current = report.currentProvider;
    if (!current || typeof current !== 'object') {
        throw new Error('Intermediate live report requires currentProvider');
    }
    if (expected.provider && current.provider !== expected.provider) {
        throw new Error('currentProvider.provider mismatch: ' + current.provider);
    }
    if (expected.stage && current.stage !== expected.stage) {
        throw new Error('currentProvider.stage mismatch: ' + current.stage);
    }
    if (expected.requireMediapipeOverlay === true) {
        if (current.mediapipeOverlayAcceptance?.success !== true) {
            throw new Error(
                'Intermediate report missing successful mediapipeOverlayAcceptance: ' +
                JSON.stringify(current.mediapipeOverlayAcceptance));
        }
        const inResults = report.results.some(row =>
            row?.provider === current.provider &&
            row?.mediapipeOverlayAcceptance?.success === true);
        if (inResults) {
            throw new Error(
                'Intermediate report should not yet finalize provider in results[]');
        }
    }
    return true;
}

/** After provider stages finish: checks are on results[], currentProvider cleared. */
export function assertCompletedLiveReport(report, expected = {}) {
    if (!report || typeof report !== 'object') {
        throw new Error('Live report missing: ' + String(report));
    }
    if (!Array.isArray(report.results) || report.results.length < 1) {
        throw new Error('Completed live report requires results[]');
    }
    if (report.currentProvider != null) {
        throw new Error(
            'Completed live report must clear currentProvider: ' +
            JSON.stringify(report.currentProvider));
    }
    const provider = expected.provider;
    if (!provider) {
        throw new Error('assertCompletedLiveReport requires expected.provider');
    }
    const row = report.results.find(item => item?.provider === provider);
    if (!row) {
        throw new Error('Completed report missing provider row: ' + provider);
    }
    if (expected.requireMediapipeOverlay === true &&
        row.mediapipeOverlayAcceptance?.success !== true) {
        throw new Error(
            'Completed report missing successful mediapipeOverlayAcceptance: ' +
            JSON.stringify(row.mediapipeOverlayAcceptance));
    }
    if (expected.requireLocalBenchmark === true &&
        row.localBenchmarkAcceptance?.success !== true) {
        throw new Error(
            'Completed report missing successful localBenchmarkAcceptance: ' +
            JSON.stringify(row.localBenchmarkAcceptance));
    }
    return true;
}
