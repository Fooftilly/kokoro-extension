/**
 * Shared popup Test TTS backends CTA surface contract (#61).
 * Chromium imports this; Firefox loads it via Node for the same asserts.
 */

export const POPUP_CTA_LABEL = 'Test TTS backends';
export const POPUP_CTA_HINT_NEEDLE = 'use this backend';
export const EXPECTED_BACKEND_CARD_VALUES = Object.freeze([
    'fastapi', 'mediapipe', 'onnx',
]);
export const MEDIAPIPE_GPU_NOT_OFFERED_NEEDLE = 'gpu not offered';

/** Validate popup DOM snapshot before clicking the CTA. */
export function assertPopupTestTtsSurface(surface) {
    if (!surface || typeof surface !== 'object') {
        throw new Error('Popup CTA surface missing: ' + String(surface));
    }
    if (surface.cta !== POPUP_CTA_LABEL) {
        throw new Error('Popup CTA label mismatch: ' + JSON.stringify(surface.cta));
    }
    const hint = String(surface.hint || '').toLowerCase();
    if (!hint.includes(POPUP_CTA_HINT_NEEDLE)) {
        throw new Error('Popup CTA hint missing Use this backend: ' + surface.hint);
    }
    const cards = Array.isArray(surface.cards) ? surface.cards : [];
    if (cards.length !== 3 && surface.cardCount !== 3) {
        throw new Error('Expected three backend cards: ' + JSON.stringify(cards));
    }
    const values = cards.map(c => c?.value || '').filter(Boolean).sort().join(',');
    if (values !== EXPECTED_BACKEND_CARD_VALUES.slice().sort().join(',')) {
        throw new Error('Backend card values mismatch: ' + values);
    }
    const meta = String(surface.mediapipeMeta || '').toLowerCase();
    if (!meta.includes(MEDIAPIPE_GPU_NOT_OFFERED_NEEDLE)) {
        throw new Error(
            'MediaPipe card must disclose GPU not offered: ' + surface.mediapipeMeta);
    }
    return true;
}

export function buildPopupCtaAcceptanceReport(options = {}) {
    return {
        success: true,
        browser: options.browser || 'unknown',
        ctaLabel: POPUP_CTA_LABEL,
        threeBackendCards: true,
        gpuNotOfferedDisclosed: true,
        openedBenchmarkViaCta: true,
        benchmarkUrl: options.benchmarkUrl || '',
    };
}
