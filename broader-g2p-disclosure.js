// #61 / KE-55 — multi-lang / long-form G2P honesty (additive to KE-41b / #169).
// Short English remains dictionary-gated; broader pronunciation quality is unmeasured.
// Hybrid classic + ESM so live dual / Jest can load the same disclosure.
const BROADER_G2P_DISCLOSURE_NEEDLE =
    'multi-lang / long-form G2P not measured; short English dictionary-gated only';

/** Non-English probe excluded from measured G2P / pronunciation claims. */
const MULTI_LANG_PROBE_WORD = 'привет';

/**
 * Disclose that multi-language G2P and long-form pronunciation quality are
 * not measured. Measured honesty stays dictionary-gated short English only.
 *
 * @returns {{
 *   multiLangG2pMeasured: false,
 *   longFormPronunciationQualityMeasured: false,
 *   dictionaryGatedShortEnglishOnly: true,
 *   disclosureNeedle: string
 * }}
 */
function discloseBroaderG2pLimits() {
    return {
        multiLangG2pMeasured: false,
        longFormPronunciationQualityMeasured: false,
        dictionaryGatedShortEnglishOnly: true,
        disclosureNeedle: BROADER_G2P_DISCLOSURE_NEEDLE,
    };
}

/**
 * Non-ASCII / non-English tokens are outside the measured short-English
 * dictionary path and must not be treated as measured G2P claims.
 *
 * @param {string} word
 * @returns {boolean}
 */
function isExcludedFromMeasuredG2pClaims(word) {
    if (typeof word !== 'string') return false;
    for (let i = 0; i < word.length; i++) {
        if (word.charCodeAt(i) > 127) return true;
    }
    return false;
}

const api = {
    BROADER_G2P_DISCLOSURE_NEEDLE,
    MULTI_LANG_PROBE_WORD,
    discloseBroaderG2pLimits,
    isExcludedFromMeasuredG2pClaims,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof globalThis !== 'undefined') {
    globalThis.KokoroBroaderG2pDisclosure = api;
}

export {
    BROADER_G2P_DISCLOSURE_NEEDLE,
    MULTI_LANG_PROBE_WORD,
    discloseBroaderG2pLimits,
    isExcludedFromMeasuredG2pClaims,
};
