/**
 * #61 / KE-46 — store / distribution signing disclosure for dual-scope acceptance.
 * Packages are not claimed Chrome Web Store / AMO signed; signing is unmeasured.
 * Shared by Chromium + Firefox dual live harnesses + Jest contracts.
 */

export const STORE_SIGNING_NOT_MEASURED_NEEDLE =
    'store distribution signing not measured';

/**
 * Assert a measured-export / dual report discloses store signing as not
 * measured and packages as not store-signed. Accepts either a full export
 * payload (with nested `storeSigning`) or a standalone disclosure block.
 *
 * @param {object} report
 * @returns {{
 *   success: true,
 *   storePackagesSigned: false,
 *   storeSigningMeasured: false,
 *   disclosureNeedle: string
 * }}
 */
export function assertStoreSigningDisclosure(report) {
    if (!report || typeof report !== 'object') {
        throw Error('Store signing disclosure report missing');
    }
    const block = report.storeSigning && typeof report.storeSigning === 'object'
        ? report.storeSigning
        : report;
    if (block.storePackagesSigned !== false) {
        throw Error(
            'Store packages must not be claimed signed (CWS/AMO): ' +
            JSON.stringify(block));
    }
    if (block.storeSigningMeasured !== false) {
        throw Error(
            'Store distribution signing must not be reported as measured: ' +
            JSON.stringify(block));
    }
    const needle = String(block.disclosureNeedle || '').toLowerCase();
    if (!needle.includes(STORE_SIGNING_NOT_MEASURED_NEEDLE)) {
        throw Error(
            'Store signing disclosure needle missing from disclosureNeedle: ' +
            JSON.stringify(block.disclosureNeedle));
    }
    const haystack = JSON.stringify(block).toLowerCase();
    if (!haystack.includes(STORE_SIGNING_NOT_MEASURED_NEEDLE)) {
        throw Error(
            'Store signing disclosure text missing from report block: ' +
            JSON.stringify(block));
    }
    return {
        success: true,
        storePackagesSigned: false,
        storeSigningMeasured: false,
        disclosureNeedle: STORE_SIGNING_NOT_MEASURED_NEEDLE,
    };
}

export function buildStoreSigningDisclosureReport(options = {}) {
    return {
        success: options.success !== false,
        browser: options.browser || 'unknown',
        storePackagesSigned: false,
        storeSigningMeasured: false,
        disclosureNeedle: STORE_SIGNING_NOT_MEASURED_NEEDLE,
        assertedFromExport: options.assertedFromExport !== false,
    };
}
