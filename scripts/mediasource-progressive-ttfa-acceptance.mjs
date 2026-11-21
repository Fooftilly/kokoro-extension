/**
 * #61 — progressive MediaSource / streaming TTFA acceptance.
 *
 * KE-54: honesty scaffolding when MSE path is unavailable (unmeasured).
 * Measured leave-open: require real finite TTFA when MediaSource progressive
 * playback succeeds; fail closed (never invent numbers) when unavailable.
 */

/** Canonical KE-54 honesty needle for dual report blocks. */
export const PROGRESSIVE_MEDIASOURCE_TTFA_NOT_MEASURED_NEEDLE =
    'progressive MediaSource TTFA not measured';

/** KE-41c page/status needle (word-order variant already shipped). */
export const MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE =
    'MediaSource progressive TTFA not measured';

/** Status / report needle when progressive MSE TTFA was timed. */
export const PROGRESSIVE_MEDIASOURCE_TTFA_MEASURED_NEEDLE =
    'progressive MediaSource TTFA measured';

/** Status needle when MSE progressive path cannot run. */
export const PROGRESSIVE_MEDIASOURCE_TTFA_UNAVAILABLE_NEEDLE =
    'progressive MediaSource TTFA unavailable';

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
 * @param {unknown} text
 * @returns {boolean}
 */
export function disclosureHasProgressiveTtfaMeasuredNeedle(text) {
    const needle = String(text || '').toLowerCase();
    return needle.includes('progressive') &&
        needle.includes('mediasource') &&
        needle.includes('ttfa') &&
        /\bmeasured\b/.test(needle) &&
        !needle.includes('not measured');
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function disclosureHasProgressiveTtfaUnavailableNeedle(text) {
    const needle = String(text || '').toLowerCase();
    return needle.includes('progressive') &&
        needle.includes('mediasource') &&
        needle.includes('ttfa') &&
        needle.includes('unavailable');
}

/**
 * Normalize KE-54/measured flags from a dual/report block or FastAPI card.
 * @param {object} report
 */
function normalizeProgressiveBlock(report) {
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
    const ttfaP50Ms = src.progressiveStreamingTtfaP50Ms ??
        src.mediasourceProgressiveTtfaP50Ms ??
        src.ttfaP50Ms;
    const unavailable = src.progressiveStreamingTtfaUnavailable === true ||
        src.mediasourceProgressiveTtfaUnavailable === true;
    return {
        progressiveStreamingTtfaMeasured: progressive,
        trueMediaSourceTtfaMeasured: trueMs,
        disclosureNeedle: String(disclosure || ''),
        progressiveStreamingTtfaP50Ms: ttfaP50Ms,
        progressiveStreamingTtfaUnavailable: unavailable,
        usedMediaSource: src.usedMediaSource === true,
    };
}

/**
 * Assert progressive / true MediaSource TTFA remains explicitly unmeasured.
 * Fail closed when either measured flag is true, missing, or non-false.
 *
 * @param {object} report
 */
export function assertProgressiveStreamingTtfaUnmeasured(report) {
    if (!report || typeof report !== 'object') {
        throw Error('Progressive MediaSource TTFA report missing');
    }
    const block = normalizeProgressiveBlock(report);
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

function assertUnavailableProgressiveBlock(block) {
    if (block.progressiveStreamingTtfaMeasured === true) {
        throw Error(
            'unavailable progressive MediaSource path must not claim measured');
    }
    if (block.trueMediaSourceTtfaMeasured === true) {
        throw Error(
            'unavailable progressive MediaSource path must not claim ' +
            'trueMediaSourceTtfaMeasured');
    }
    if (Number.isFinite(block.progressiveStreamingTtfaP50Ms)) {
        throw Error(
            'unavailable progressive MediaSource path must not invent TTFA ms: ' +
            JSON.stringify(block.progressiveStreamingTtfaP50Ms));
    }
    if (!disclosureHasProgressiveTtfaUnavailableNeedle(block.disclosureNeedle) &&
        !disclosureHasProgressiveTtfaNeedle(block.disclosureNeedle)) {
        throw Error(
            'unavailable progressive MediaSource TTFA needs disclosure: ' +
            JSON.stringify(block.disclosureNeedle));
    }
    return {
        success: true,
        progressiveStreamingTtfaMeasured: false,
        progressiveStreamingTtfaUnavailable: true,
        progressiveStreamingTtfaP50Ms: null,
        usedMediaSource: block.usedMediaSource,
        disclosureNeedle: block.disclosureNeedle ||
            PROGRESSIVE_MEDIASOURCE_TTFA_UNAVAILABLE_NEEDLE,
    };
}

function assertMeasuredProgressiveBlock(block) {
    if (block.progressiveStreamingTtfaMeasured !== true) {
        throw Error(
            'progressiveStreamingTtfaMeasured must be true when path available: ' +
            JSON.stringify(block.progressiveStreamingTtfaMeasured));
    }
    if (block.trueMediaSourceTtfaMeasured !== true &&
        block.trueMediaSourceTtfaMeasured !== false) {
        // Accept true (progressive MSE) or explicit false only when nested
        // trueMediaSource flag is unused; require boolean when present.
        throw Error(
            'trueMediaSourceTtfaMeasured must be boolean when present: ' +
            JSON.stringify(block.trueMediaSourceTtfaMeasured));
    }
    if (!(Number.isFinite(block.progressiveStreamingTtfaP50Ms) &&
        block.progressiveStreamingTtfaP50Ms >= 0)) {
        throw Error(
            'progressiveStreamingTtfaP50Ms must be a finite nonnegative ms ' +
            'value (never invent): ' +
            JSON.stringify(block.progressiveStreamingTtfaP50Ms));
    }
    if (block.usedMediaSource !== true) {
        throw Error(
            'usedMediaSource must be true for measured progressive TTFA');
    }
    if (!disclosureHasProgressiveTtfaMeasuredNeedle(block.disclosureNeedle)) {
        throw Error(
            'disclosure needle missing progressive MediaSource TTFA measured: ' +
            JSON.stringify(block.disclosureNeedle));
    }
    return {
        success: true,
        progressiveStreamingTtfaMeasured: true,
        progressiveStreamingTtfaUnavailable: false,
        progressiveStreamingTtfaP50Ms: block.progressiveStreamingTtfaP50Ms,
        usedMediaSource: true,
        disclosureNeedle: PROGRESSIVE_MEDIASOURCE_TTFA_MEASURED_NEEDLE,
    };
}

/**
 * Assert progressive MediaSource TTFA was measured with a real finite p50,
 * or fail-closed unavailable (no invented numbers).
 * Nested helpers keep CodeFactor method complexity under the gate.
 *
 * @param {object} report
 */
export function assertProgressiveStreamingTtfaMeasured(report) {
    if (!report || typeof report !== 'object') {
        throw Error('Progressive MediaSource TTFA measured report missing');
    }
    const block = normalizeProgressiveBlock(report);
    if (block.progressiveStreamingTtfaUnavailable === true) {
        return assertUnavailableProgressiveBlock(block);
    }
    return assertMeasuredProgressiveBlock(block);
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

/**
 * Dual-report acceptance block for measured / unavailable progressive TTFA.
 * @param {object} [options]
 */
export function buildProgressiveStreamingTtfaMeasuredReport(options = {}) {
    const unavailable = options.progressiveStreamingTtfaUnavailable === true ||
        options.unavailable === true;
    if (unavailable) {
        return {
            success: options.success !== false,
            browser: options.browser || 'unknown',
            progressiveStreamingTtfaMeasured: false,
            trueMediaSourceTtfaMeasured: false,
            progressiveStreamingTtfaUnavailable: true,
            progressiveStreamingTtfaP50Ms: null,
            usedMediaSource: options.usedMediaSource === true,
            disclosureNeedle: options.disclosureNeedle ||
                PROGRESSIVE_MEDIASOURCE_TTFA_UNAVAILABLE_NEEDLE,
            assertedFromServerCard: options.assertedFromServerCard !== false,
        };
    }
    const ttfaP50Ms = options.progressiveStreamingTtfaP50Ms ??
        options.ttfaP50Ms;
    if (!(Number.isFinite(ttfaP50Ms) && ttfaP50Ms >= 0)) {
        throw Error(
            'buildProgressiveStreamingTtfaMeasuredReport requires finite p50 ms');
    }
    if (options.usedMediaSource === false) {
        throw Error(
            'buildProgressiveStreamingTtfaMeasuredReport requires usedMediaSource');
    }
    return {
        success: options.success !== false,
        browser: options.browser || 'unknown',
        progressiveStreamingTtfaMeasured: true,
        trueMediaSourceTtfaMeasured: true,
        progressiveStreamingTtfaUnavailable: false,
        progressiveStreamingTtfaP50Ms: ttfaP50Ms,
        usedMediaSource: true,
        disclosureNeedle: options.disclosureNeedle ||
            PROGRESSIVE_MEDIASOURCE_TTFA_MEASURED_NEEDLE,
        assertedFromServerCard: options.assertedFromServerCard !== false,
    };
}
