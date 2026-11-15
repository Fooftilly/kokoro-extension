// #61 / KE-46 — honest store / distribution signing disclosure.
// Packages are not claimed Chrome Web Store / AMO signed; signing is unmeasured.
// Hybrid classic + ESM so model-manager can import and Jest can require.
const STORE_SIGNING_NOT_MEASURED_NEEDLE = 'store distribution signing not measured';

/**
 * Disclose that store / distribution signing is not measured and that
 * packaged artifacts are not claimed store-signed (CWS / AMO).
 *
 * @returns {{
 *   storePackagesSigned: false,
 *   storeSigningMeasured: false,
 *   disclosureNeedle: string
 * }}
 */
function discloseStoreSigning() {
    return {
        storePackagesSigned: false,
        storeSigningMeasured: false,
        disclosureNeedle: STORE_SIGNING_NOT_MEASURED_NEEDLE,
    };
}

const api = {
    STORE_SIGNING_NOT_MEASURED_NEEDLE,
    discloseStoreSigning,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof globalThis !== 'undefined') {
    globalThis.KokoroStoreSigningDisclosure = api;
}

export {
    STORE_SIGNING_NOT_MEASURED_NEEDLE,
    discloseStoreSigning,
};
