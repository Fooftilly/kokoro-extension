/**
 * #57 / #61 / KE-53 — other model variants + verified-GPU-when-offered disclosure.
 * Dual scopes accept only onnx-q8 + MediaPipe CPU. Catalog may still list other
 * variants (e.g. onnx-q8f16); those must be observed and marked unmeasured.
 * Shared by Chromium + Firefox dual live harnesses + Jest contracts.
 *
 * Callers pass listModelVariants() results (or keys) — do not import
 * model-catalog.js here (package.json is CommonJS; live harnesses load via
 * temp .mjs copy).
 */

export const ACCEPTED_MODEL_VARIANTS = Object.freeze(['mediapipe-cpu', 'onnx-q8']);

/** Catalog key that must appear among non-accepted offered variants. */
export const REQUIRED_NON_ACCEPTED_CATALOG_VARIANT = 'onnx-q8f16';

export const MODEL_VARIANTS_DISCLOSURE_NEEDLE =
    'other catalog variants not measured; only onnx-q8 + mediapipe-cpu accepted; ' +
    'verified GPU when offered not measured';

function normalizeVariantKeys(raw) {
    if (!Array.isArray(raw)) return null;
    return [...new Set(raw.map(item => String(item)))]
        .sort((a, b) => a.localeCompare(b));
}

function expectedAcceptedKeys() {
    return [...ACCEPTED_MODEL_VARIANTS].sort((a, b) => a.localeCompare(b));
}

/**
 * Normalize product-offered catalog entries from listModelVariants().
 * @param {Array<{key?: string}>|string[]} listed
 * @returns {string[]}
 */
export function observeCatalogVariantKeys(listed) {
    if (!Array.isArray(listed)) {
        throw Error('listModelVariants evidence must be an array');
    }
    const keys = listed.map((entry) => {
        if (typeof entry === 'string') return entry;
        if (!entry || typeof entry !== 'object') {
            throw Error('Catalog variant entry missing: ' + JSON.stringify(entry));
        }
        return String(entry.key || '');
    }).filter(Boolean);
    if (keys.length === 0) {
        throw Error('Catalog offered zero model variants');
    }
    return normalizeVariantKeys(keys);
}

function requireDisclosureBlock(report) {
    if (!report || typeof report !== 'object') {
        throw Error('Model variants disclosure report missing');
    }
    return report.modelVariants && typeof report.modelVariants === 'object'
        ? report.modelVariants
        : report;
}

function assertAcceptedVariants(block) {
    const accepted = normalizeVariantKeys(block.acceptedVariants);
    if (!accepted) {
        throw Error(
            'acceptedVariants must be an array of documented keys: ' +
            JSON.stringify(block.acceptedVariants));
    }
    const expectedAccepted = expectedAcceptedKeys();
    if (accepted.length !== expectedAccepted.length ||
        accepted.some((key, index) => key !== expectedAccepted[index])) {
        throw Error(
            'acceptedVariants must be exactly onnx-q8 + mediapipe-cpu: ' +
            JSON.stringify(block.acceptedVariants));
    }
    return expectedAccepted;
}

function assertObservedCatalogEvidence(block, expectedAccepted) {
    const observed = normalizeVariantKeys(block.observedCatalogVariantKeys);
    if (!observed) {
        throw Error(
            'observedCatalogVariantKeys required from listModelVariants evidence: ' +
            JSON.stringify(block.observedCatalogVariantKeys));
    }
    for (const key of expectedAccepted) {
        if (!observed.includes(key)) {
            throw Error(
                'Catalog evidence missing accepted variant ' + key + ': ' +
                JSON.stringify(observed));
        }
    }
    if (!observed.includes(REQUIRED_NON_ACCEPTED_CATALOG_VARIANT)) {
        throw Error(
            'Catalog evidence must include offered non-accepted ' +
            REQUIRED_NON_ACCEPTED_CATALOG_VARIANT + ': ' +
            JSON.stringify(observed));
    }

    const nonAccepted = observed.filter((key) => !expectedAccepted.includes(key));
    if (nonAccepted.length === 0) {
        throw Error(
            'Catalog evidence must expose at least one non-accepted variant: ' +
            JSON.stringify(observed));
    }
    if (!nonAccepted.includes(REQUIRED_NON_ACCEPTED_CATALOG_VARIANT)) {
        throw Error(
            'Non-accepted catalog set must include ' +
            REQUIRED_NON_ACCEPTED_CATALOG_VARIANT + ': ' +
            JSON.stringify(nonAccepted));
    }
    return { observed, nonAccepted };
}

function assertHonestyFlags(block) {
    // Catalog offers extras (e.g. onnx-q8f16) — honesty must not claim they
    // are absent from the product catalog.
    if (block.otherCatalogVariantsOffered !== true) {
        throw Error(
            'otherCatalogVariantsOffered must be true when catalog lists extras: ' +
            JSON.stringify(block));
    }
    if (block.otherModelVariantsMeasured !== false) {
        throw Error(
            'Other model variants must not be reported as measured: ' +
            JSON.stringify(block));
    }
    if (block.verifiedGpuWhenOfferedMeasured !== false) {
        throw Error(
            'Verified GPU when offered must not be reported as measured: ' +
            JSON.stringify(block));
    }
    if (block.assertedFromCatalog !== true) {
        throw Error(
            'Model variants disclosure must set assertedFromCatalog true: ' +
            JSON.stringify(block.assertedFromCatalog));
    }
}

function assertDisclosureNeedle(block) {
    const needle = String(block.disclosureNeedle || '').toLowerCase();
    if (!needle.includes('other catalog variants not measured') ||
        !needle.includes('only onnx-q8 + mediapipe-cpu accepted') ||
        !needle.includes('verified gpu when offered not measured')) {
        throw Error(
            'Model variants disclosure needle missing required phrases: ' +
            JSON.stringify(block.disclosureNeedle));
    }
    const haystack = JSON.stringify(block).toLowerCase();
    if (!haystack.includes('other catalog variants not measured')) {
        throw Error(
            'Model variants disclosure text missing from report block: ' +
            JSON.stringify(block));
    }
}

/**
 * Assert dual disclosure against catalog evidence + honesty flags.
 * Fail closed if onnx-q8f16 (or other non-accepted catalog keys) are missing
 * from observedCatalogVariantKeys, or if non-accepted variants are claimed measured.
 *
 * @param {object} report
 */
export function assertModelVariantsDisclosure(report) {
    const block = requireDisclosureBlock(report);
    const expectedAccepted = assertAcceptedVariants(block);
    const { observed, nonAccepted } =
        assertObservedCatalogEvidence(block, expectedAccepted);
    assertHonestyFlags(block);
    assertDisclosureNeedle(block);

    return {
        success: true,
        acceptedVariants: expectedAccepted,
        observedCatalogVariantKeys: observed,
        nonAcceptedCatalogVariants: nonAccepted,
        otherCatalogVariantsOffered: true,
        otherModelVariantsMeasured: false,
        verifiedGpuWhenOfferedMeasured: false,
        assertedFromCatalog: true,
        disclosureNeedle: MODEL_VARIANTS_DISCLOSURE_NEEDLE,
    };
}

/**
 * Build disclosure report from observed catalog keys (not hard-coded alone).
 * @param {object} options
 */
export function buildModelVariantsDisclosureReport(options = {}) {
    const observed = options.listedVariants
        ? observeCatalogVariantKeys(options.listedVariants)
        : normalizeVariantKeys(options.observedCatalogVariantKeys);
    if (!observed) {
        throw Error(
            'observedCatalogVariantKeys or listedVariants required from catalog');
    }
    const accepted = expectedAcceptedKeys();
    const nonAccepted = observed.filter((key) => !accepted.includes(key));
    return {
        success: options.success !== false,
        browser: options.browser || 'unknown',
        acceptedVariants: accepted,
        observedCatalogVariantKeys: observed,
        nonAcceptedCatalogVariants: nonAccepted,
        otherCatalogVariantsOffered: nonAccepted.length > 0,
        otherModelVariantsMeasured: false,
        verifiedGpuWhenOfferedMeasured: false,
        disclosureNeedle: MODEL_VARIANTS_DISCLOSURE_NEEDLE,
        assertedFromCatalog: true,
        assertedFromDual: options.assertedFromDual !== false,
    };
}
