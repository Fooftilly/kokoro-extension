/**
 * #61 / KE-41b — ONNX English is dictionary-gated; OOV fails closed;
 * broader long-form G2P is not claimed. Shared by Chromium dual + Jest.
 */

export const ONNX_ENGLISH_G2P_DISCLOSURE_NEEDLE =
    'dictionary-gated English; OOV fails closed; broader G2P not measured';

export const OOV_PROBE_WORD = 'zzzzqwertyword';
export const OOV_FAIL_CLOSED_NEEDLE =
    /Missing English pronunciation|Unsupported English text|IPA-only diagnostic/;

function requireFlag(payload, key, expected, message) {
    if (payload?.[key] !== expected) {
        throw Error(message + ': ' + JSON.stringify(payload?.[key]));
    }
}

/**
 * Assert disclosure flags and that fail-closed / IPA-exclusion was observed.
 * @param {object} report
 */
export function assertOnnxOovG2pDisclosure(report) {
    if (!report || typeof report !== 'object') {
        throw Error('OOV/G2P disclosure report missing');
    }
    requireFlag(report, 'dictionaryGatedEnglish', true,
        'ONNX English must disclose dictionary gating');
    requireFlag(report, 'broaderG2pMeasured', false,
        'Broader long-form G2P must not be claimed as measured');
    requireFlag(report, 'oovFailsClosed', true,
        'OOV must disclose fail-closed behavior');
    const needle = String(report.disclosureNeedle || '');
    if (!needle.includes('dictionary-gated') ||
        !needle.includes('OOV fails closed') ||
        !needle.includes('broader G2P not measured')) {
        throw Error('OOV/G2P disclosure needle mismatch: ' + needle);
    }
    if (report.unknownWordsRejected !== true &&
        report.ipaOnlyExcluded !== true) {
        throw Error(
            'OOV disclosure requires unknownWordsRejected or ipaOnlyExcluded');
    }
    return true;
}

export function buildOovG2pDisclosureReport(options = {}) {
    return {
        success: options.success !== false,
        browser: options.browser || 'chromium',
        dictionaryGatedEnglish: true,
        broaderG2pMeasured: false,
        oovFailsClosed: true,
        disclosureNeedle: ONNX_ENGLISH_G2P_DISCLOSURE_NEEDLE,
        unknownWordsRejected: options.unknownWordsRejected === true,
        ipaOnlyExcluded: options.ipaOnlyExcluded === true,
        oovProbe: options.oovProbe || OOV_PROBE_WORD,
    };
}

export function assertOovG2pDisclosureReport(report) {
    if (!report?.success) {
        throw Error('OOV/G2P disclosure acceptance not successful');
    }
    assertOnnxOovG2pDisclosure(report);
    return true;
}
