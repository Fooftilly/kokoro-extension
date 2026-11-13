/**
 * Pure helpers for floating selection mic geometry (#11).
 * Kept free of DOM/browser APIs so Jest can cover end-caret + clamp without pointer E2E.
 * Loaded as a classic content-script before content.js; also CommonJS-friendly for tests.
 */
(function (root) {
    'use strict';

    const FLOAT_MIC_BTN_SIZE = 36;
    const FLOAT_MIC_MARGIN = 10;
    const FLOAT_MIC_SELECTION_THROTTLE_MS = 100;

    /**
     * @param {unknown} value
     * @returns {{ top: number, left: number, bottom: number, right: number, width: number, height: number } | null}
     */
    function normalizeClientRect(value) {
        if (!value || typeof value !== 'object') return null;
        const top = Number(value.top);
        const left = Number(value.left);
        const bottom = Number(value.bottom);
        const right = Number(value.right);
        const width = Number(value.width);
        const height = Number(value.height);
        if (![top, left, bottom, right, width, height].every(Number.isFinite)) return null;
        return { top, left, bottom, right, width, height };
    }

    /**
     * True when a rect has a usable caret/box position (zero-size collapsed carets allowed).
     * @param {{ top: number, left: number, bottom: number, right: number, width: number, height: number } | null} box
     */
    function hasUsableClientRect(box) {
        if (!box) return false;
        if (box.width > 0 || box.height > 0) return true;
        return box.top !== 0 || box.left !== 0 || box.bottom !== 0 || box.right !== 0;
    }

    /**
     * Selection end caret client rect (not the whole-range bounding box).
     * @param {{ cloneRange: Function, getClientRects: Function, getBoundingClientRect: Function } | null | undefined} range
     */
    function getSelectionEndClientRect(range) {
        if (!range || typeof range.cloneRange !== 'function') return null;

        try {
            const endRange = range.cloneRange();
            endRange.collapse(false);
            const endBox = normalizeClientRect(endRange.getBoundingClientRect());
            if (hasUsableClientRect(endBox)) return endBox;
        } catch { /* fall through */ }

        try {
            const rects = range.getClientRects ? range.getClientRects() : [];
            if (rects && rects.length > 0) {
                const last = normalizeClientRect(rects[rects.length - 1]);
                if (hasUsableClientRect(last)) return last;
            }
        } catch { /* fall through */ }

        try {
            return normalizeClientRect(range.getBoundingClientRect());
        } catch {
            return null;
        }
    }

    /**
     * Preferred fixed position: slightly above and centered on the end caret's right edge.
     * Flips below the caret when the preferred top would sit above the viewport margin.
     *
     * @param {{ top: number, left: number, bottom: number, right: number }} endRect
     * @param {{ btnSize?: number, margin?: number }} [opts]
     * @returns {{ left: number, top: number }}
     */
    function preferredFloatingMicPosition(endRect, opts = {}) {
        const btnSize = Number.isFinite(opts.btnSize) ? opts.btnSize : FLOAT_MIC_BTN_SIZE;
        const margin = Number.isFinite(opts.margin) ? opts.margin : FLOAT_MIC_MARGIN;

        const left = endRect.right - (btnSize / 2);
        let top = endRect.top - btnSize - margin;
        if (top < margin) {
            top = endRect.bottom + margin;
        }
        return { left, top };
    }

    /**
     * Clamp mic top-left so the control stays fully on-screen (all four edges).
     *
     * @param {number} left
     * @param {number} top
     * @param {{ btnSize?: number, margin?: number, viewportWidth: number, viewportHeight: number }} box
     * @returns {{ left: number, top: number }}
     */
    function clampFloatingMicPosition(left, top, box) {
        const btnSize = Number.isFinite(box.btnSize) ? box.btnSize : FLOAT_MIC_BTN_SIZE;
        const margin = Number.isFinite(box.margin) ? box.margin : FLOAT_MIC_MARGIN;
        const vw = Math.max(0, box.viewportWidth);
        const vh = Math.max(0, box.viewportHeight);

        const maxLeft = Math.max(margin, vw - btnSize - margin);
        const maxTop = Math.max(margin, vh - btnSize - margin);
        const minLeft = margin;
        const minTop = margin;

        const clampedLeft = Math.min(maxLeft, Math.max(minLeft, left));
        const clampedTop = Math.min(maxTop, Math.max(minTop, top));

        return {
            left: Number.isFinite(clampedLeft) ? clampedLeft : margin,
            top: Number.isFinite(clampedTop) ? clampedTop : margin
        };
    }

    /**
     * @param {{ top: number, left: number, bottom: number, right: number } | null | undefined} endRect
     * @param {{ viewportWidth: number, viewportHeight: number, btnSize?: number, margin?: number }} viewport
     * @returns {{ left: number, top: number } | null}
     */
    function computeFloatingMicPosition(endRect, viewport) {
        const normalized = normalizeClientRect(endRect);
        if (!hasUsableClientRect(normalized)) return null;

        const preferred = preferredFloatingMicPosition(normalized, viewport);
        return clampFloatingMicPosition(preferred.left, preferred.top, viewport);
    }

    const api = {
        FLOAT_MIC_BTN_SIZE,
        FLOAT_MIC_MARGIN,
        FLOAT_MIC_SELECTION_THROTTLE_MS,
        normalizeClientRect,
        getSelectionEndClientRect,
        preferredFloatingMicPosition,
        clampFloatingMicPosition,
        computeFloatingMicPosition
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.KokoroFloatingMicPosition = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
