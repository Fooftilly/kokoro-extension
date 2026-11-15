/**
 * #61 / KE-55 — multi-lang / long-form G2P not-measured disclosure.
 * Additive to KE-41b dictionary-gated short English (#169). Shared by
 * Chromium + Firefox dual live harnesses + Jest contracts.
 */

export const BROADER_G2P_DISCLOSURE_NEEDLE =
    'multi-lang / long-form G2P not measured; short English dictionary-gated only';

/** Cyrillic probe — outside Latin CMUdict path; excluded from measured claims. */
export const MULTI_LANG_PROBE_WORD = 'привет';

export function isExcludedFromMeasuredG2pClaims(word) {
    if (typeof word !== 'string') return false;
    for (let i = 0; i < word.length; i++) {
        if (word.charCodeAt(i) > 127) return true;
    }
    return false;
}

function requireFlag(payload, key, expected, message) {
    if (payload?.[key] !== expected) {
        throw Error(message + ': ' + JSON.stringify(payload?.[key]));
    }
}

/**
 * Assert multi-lang / long-form G2P honesty flags.
 * Short English dictionary-gated path remains the only measured claim.
 *
 * @param {object} report
 * @returns {{
 *   success: true,
 *   multiLangG2pMeasured: false,
 *   longFormPronunciationQualityMeasured: false,
 *   dictionaryGatedShortEnglishOnly: true,
 *   multiLangProbeExcluded: true,
 *   disclosureNeedle: string
 * }}
 */
export function assertBroaderG2pDisclosure(report) {
    if (!report || typeof report !== 'object') {
        throw Error('Broader G2P disclosure report missing');
    }
    requireFlag(report, 'multiLangG2pMeasured', false,
        'Multi-lang G2P must not be claimed as measured');
    requireFlag(report, 'longFormPronunciationQualityMeasured', false,
        'Long-form pronunciation quality must not be claimed as measured');
    requireFlag(report, 'dictionaryGatedShortEnglishOnly', true,
        'Measured path must remain dictionary-gated short English only');
    const needle = String(report.disclosureNeedle || '');
    if (!needle.includes('multi-lang / long-form G2P not measured') ||
        !needle.includes('short English dictionary-gated only')) {
        throw Error('Broader G2P disclosure needle mismatch: ' + needle);
    }
    if (report.multiLangProbeExcluded !== true) {
        throw Error(
            'Non-English multi-lang probe must be excluded from measured claims');
    }
    return {
        success: true,
        multiLangG2pMeasured: false,
        longFormPronunciationQualityMeasured: false,
        dictionaryGatedShortEnglishOnly: true,
        multiLangProbeExcluded: true,
        disclosureNeedle: BROADER_G2P_DISCLOSURE_NEEDLE,
    };
}

export function buildBroaderG2pDisclosureReport(options = {}) {
    const probe = options.multiLangProbeWord || MULTI_LANG_PROBE_WORD;
    return {
        success: options.success !== false,
        browser: options.browser || 'unknown',
        multiLangG2pMeasured: false,
        longFormPronunciationQualityMeasured: false,
        dictionaryGatedShortEnglishOnly: true,
        disclosureNeedle: BROADER_G2P_DISCLOSURE_NEEDLE,
        multiLangProbeWord: probe,
        multiLangProbeExcluded: isExcludedFromMeasuredG2pClaims(probe) === true,
    };
}

export function assertBroaderG2pDisclosureReport(report) {
    if (!report?.success) {
        throw Error('Broader G2P disclosure acceptance not successful');
    }
    assertBroaderG2pDisclosure(report);
    return true;
}
