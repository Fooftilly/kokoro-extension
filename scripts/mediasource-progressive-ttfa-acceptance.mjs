/**
 * #61 / KE-54 — progressive MediaSource / streaming TTFA remains unmeasured.
 * First-class dual acceptance field; fail closed if claimed measured.
 * Does not invent TTFA numbers. Shared by Chromium + Firefox + Jest.
 */

/** Canonical KE-54 honesty needle for dual report blocks. */
export const PROGRESSIVE_MEDIASOURCE_TTFA_NOT_MEASURED_NEEDLE =
    'progressive MediaSource TTFA not measured';

/** KE-41c page/status needle (word-order variant already shipped). */
export const MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE =
    'MediaSource progressive TTFA not measured';

/**
 * True when text discloses progressive MediaSource TTFA as not measured.
 * Accepts KE-54 and KE-41c word orders.
 * @param {unknown} text
 * @returns {boolean}
 */
export function disclosureHasProgressiveTtfaNeedle(text) {
    const needle = String(text || '').toLowerCase();
    return needle.includes('progressive') &&
        needle.includes('mediasource') &&
        needle.includes('ttfa') &&
        needle.includes('not measured');
}

/**
 * Normalize KE-54 flags from a dual/report block or FastAPI card report.
 * Maps KE-41c `mediasourceProgressiveTtfaMeasured` when explicit flags omit.
 * @param {object} report
 * @returns {{
 *   progressiveStreamingTtfaMeasured: unknown,
 *   trueMediaSourceTtfaMeasured: unknown,
 *   disclosureNeedle: string
 * }}
 */
function normalizeUnmeasuredBlock(report) {
    const nested = report.progressiveStreamingTtfa &&
        typeof report.progressiveStreamingTtfa === 'object'
        ? report.progressiveStreamingTtfa
        : null;
    const src = nested || report;
    let progressive = src.progressiveStreamingTtfaMeasured;
    let trueMs = src.trueMediaSourceTtfaMeasured;
    if (progressive === undefined &&
        Object.prototype.hasOwnProperty.call(
            src, 'mediasourceProgressiveTtfaMeasured')) {
        progressive = src.mediasourceProgressiveTtfaMeasured;
    }
    if (trueMs === undefined &&
        Object.prototype.hasOwnProperty.call(
            src, 'mediasourceProgressiveTtfaMeasured')) {
        trueMs = src.mediasourceProgressiveTtfaMeasured;
    }
    const disclosure = src.disclosureNeedle ||
        src.mediasourceProgressiveTtfaDisclosure ||
        '';
    return {
        progressiveStreamingTtfaMeasured: progressive,
        trueMediaSourceTtfaMeasured: trueMs,
        disclosureNeedle: String(disclosure || ''),
    };
}

/**
 * Assert progressive / true MediaSource TTFA remains explicitly unmeasured.
 * Fail closed when either measured flag is true, missing, or non-false.
 *
 * @param {object} report
 * @returns {{
 *   success: true,
 *   progressiveStreamingTtfaMeasured: false,
 *   trueMediaSourceTtfaMeasured: false,
 *   disclosureNeedle: string
 * }}
 */
export function assertProgressiveStreamingTtfaUnmeasured(report) {
    if (!report || typeof report !== 'object') {
        throw Error('Progressive MediaSource TTFA report missing');
    }
    const block = normalizeUnmeasuredBlock(report);
    if (block.progressiveStreamingTtfaMeasured !== false) {
        throw Error(
            'progressiveStreamingTtfaMeasured must be false ' +
            '(progressive MediaSource TTFA not measured): ' +
            JSON.stringify(block.progressiveStreamingTtfaMeasured));
    }
    if (block.trueMediaSourceTtfaMeasured !== false) {
        throw Error(
            'trueMediaSourceTtfaMeasured must be false ' +
            '(true MediaSource TTFA not measured): ' +
            JSON.stringify(block.trueMediaSourceTtfaMeasured));
    }
    if (!disclosureHasProgressiveTtfaNeedle(block.disclosureNeedle)) {
        throw Error(
            'disclosure needle missing progressive MediaSource TTFA ' +
            'not measured: ' + JSON.stringify(block.disclosureNeedle));
    }
    return {
        success: true,
        progressiveStreamingTtfaMeasured: false,
        trueMediaSourceTtfaMeasured: false,
        disclosureNeedle: PROGRESSIVE_MEDIASOURCE_TTFA_NOT_MEASURED_NEEDLE,
    };
}

/**
 * Dual-report acceptance block for progressive MediaSource TTFA (unmeasured).
 * @param {object} [options]
 */
export function buildProgressiveStreamingTtfaReport(options = {}) {
    return {
        success: options.success !== false,
        browser: options.browser || 'unknown',
        progressiveStreamingTtfaMeasured: false,
        trueMediaSourceTtfaMeasured: false,
        disclosureNeedle: PROGRESSIVE_MEDIASOURCE_TTFA_NOT_MEASURED_NEEDLE,
        assertedFromServerCard: options.assertedFromServerCard !== false,
    };
}
