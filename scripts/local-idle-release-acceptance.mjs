/**
 * #57 / #61 — dual-gated local AudioManager idle-release measurement.
 * Origin scopes already probe idle teardown; dual previously skipped it.
 * Fail closed: both onnx + mediapipe must release native refs offline while
 * preserving cached WAV byte-for-byte.
 */

export const LOCAL_IDLE_RELEASE_MEASURED_NEEDLE =
    'local idle release measured';

export const DUAL_IDLE_RELEASE_BACKENDS = Object.freeze(['onnx', 'mediapipe']);

/**
 * Native close() wall-time join (ms). Fail closed on non-finite / negative.
 * @param {number} startedAt
 * @param {number} endedAt
 * @returns {number}
 */
export function measureCloseJoinMs(startedAt, endedAt) {
    const joinMs = endedAt - startedAt;
    if (!Number.isFinite(joinMs) || joinMs < 0) {
        throw Error(
            'idleReleaseJoinMs must be finite nonnegative join latency: ' +
            JSON.stringify(joinMs));
    }
    return joinMs;
}

/**
 * Assert one backend idle-release probe result from probeLocalProviderIdleRelease.
 * @param {object} probe
 * @param {string} [expectedBackend]
 */
export function assertLocalIdleReleaseProbe(probe, expectedBackend) {
    if (!probe || typeof probe !== 'object') {
        throw Error('Local idle-release probe result missing');
    }
    if (probe.success !== true) {
        throw Error('Local idle-release probe must succeed: ' +
            JSON.stringify(probe));
    }
    if (probe.offline !== true) {
        throw Error('Local idle-release probe must stay offline: ' +
            JSON.stringify(probe));
    }
    if (probe.nativeModelReferencesReleased !== true ||
        probe.cachedAudioPreservedByteForByte !== true ||
        probe.cachedReplayDidNotReloadModel !== true ||
        probe.freshProviderSynthesizedAfterIdle !== true ||
        probe.repeatedIdleRelease !== true) {
        throw Error('Local idle-release probe missing required honesty flags: ' +
            JSON.stringify(probe));
    }
    if (expectedBackend && probe.backend !== expectedBackend) {
        throw Error('Local idle-release backend mismatch: ' +
            JSON.stringify(probe));
    }
    if (!Number.isInteger(probe.configuredIdleMs) || probe.configuredIdleMs < 1) {
        throw Error('Local idle-release configuredIdleMs invalid: ' +
            JSON.stringify(probe.configuredIdleMs));
    }
    if (!Number.isFinite(probe.idleReleaseJoinMs) || probe.idleReleaseJoinMs < 0) {
        throw Error('idleReleaseJoinMs must be finite nonnegative join latency: ' +
            JSON.stringify(probe.idleReleaseJoinMs));
    }
    if (!Number.isFinite(probe.repeatedIdleReleaseJoinMs) ||
        probe.repeatedIdleReleaseJoinMs < 0) {
        throw Error(
            'repeatedIdleReleaseJoinMs must be finite nonnegative join latency: ' +
            JSON.stringify(probe.repeatedIdleReleaseJoinMs));
    }
    if (probe.sampleRateHz !== 24000) {
        throw Error('Local idle-release sampleRateHz must be 24000: ' +
            JSON.stringify(probe.sampleRateHz));
    }
    return true;
}

/**
 * Assert dual idle-release acceptance for both local backends.
 * @param {object} report
 */
export function assertLocalIdleReleaseDual(report) {
    if (!report || typeof report !== 'object') {
        throw Error('Local idle-release dual report missing');
    }
    if (report.localIdleReleaseMeasured !== true) {
        throw Error('localIdleReleaseMeasured must be true on dual: ' +
            JSON.stringify(report.localIdleReleaseMeasured));
    }
    if (report.success !== true) {
        throw Error('Local idle-release dual must succeed: ' +
            JSON.stringify(report));
    }
    const backends = report.backends;
    if (!Array.isArray(backends) || backends.length !== 2) {
        throw Error('Local idle-release dual needs onnx + mediapipe probes: ' +
            JSON.stringify(backends));
    }
    const keys = backends.map((entry) => entry && entry.backend);
    for (const required of DUAL_IDLE_RELEASE_BACKENDS) {
        if (!keys.includes(required)) {
            throw Error('Local idle-release dual missing backend ' + required +
                ': ' + JSON.stringify(keys));
        }
    }
    for (const entry of backends) {
        assertLocalIdleReleaseProbe(entry, entry.backend);
    }
    const needle = String(report.disclosureNeedle || '').toLowerCase();
    if (!needle.includes(LOCAL_IDLE_RELEASE_MEASURED_NEEDLE)) {
        throw Error('Local idle-release disclosure needle missing: ' +
            JSON.stringify(report.disclosureNeedle));
    }
    return true;
}

/**
 * Build dual report from both backend probe results.
 * @param {object} options
 */
export function buildLocalIdleReleaseDualReport(options = {}) {
    const backends = Array.isArray(options.backends) ? options.backends : [];
    return {
        success: options.success !== false,
        browser: options.browser || 'unknown',
        localIdleReleaseMeasured: options.localIdleReleaseMeasured !== false,
        disclosureNeedle: LOCAL_IDLE_RELEASE_MEASURED_NEEDLE,
        backends,
        assertedFromDual: options.assertedFromDual !== false,
    };
}
