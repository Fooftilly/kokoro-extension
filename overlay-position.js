/**
 * Pure helpers for floating overlay geometry (compact/popup mode).
 * Kept free of DOM/browser APIs so Jest can cover clamp/restore without pointer E2E.
 * Loaded as a classic content-script before content.js; also CommonJS-friendly for tests.
 */
(function (root) {
    'use strict';

    const OVERLAY_POPUP_WIDTH = 320;
    const OVERLAY_POPUP_HEIGHT = 500;
    const OVERLAY_COLLAPSED_HEIGHT = 88;
    const OVERLAY_VIEWPORT_MARGIN = 8;
    const POSITION_STORAGE_KEY = 'kokoroOverlayPosition';

    /**
     * @param {unknown} value
     * @returns {{ left: number, top: number } | null}
     */
    function normalizeOverlayPosition(value) {
        if (!value || typeof value !== 'object') return null;
        const left = Number(value.left);
        const top = Number(value.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
        return { left, top };
    }

    /**
     * Clamp overlay top-left so the box stays on-screen.
     * If the viewport is smaller than the player, pin to the margin corner.
     *
     * @param {number} left
     * @param {number} top
     * @param {{ width: number, height: number, viewportWidth: number, viewportHeight: number, margin?: number }} box
     * @returns {{ left: number, top: number }}
     */
    function clampOverlayPosition(left, top, box) {
        const margin = Number.isFinite(box.margin) ? box.margin : OVERLAY_VIEWPORT_MARGIN;
        const width = Math.max(0, box.width);
        const height = Math.max(0, box.height);
        const vw = Math.max(0, box.viewportWidth);
        const vh = Math.max(0, box.viewportHeight);

        const maxLeft = Math.max(margin, vw - width - margin);
        const maxTop = Math.max(margin, vh - height - margin);
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
     * Default compact-mode position (near historical top-right 20px), as left/top.
     * @param {{ width?: number, viewportWidth: number, margin?: number }} opts
     */
    function defaultOverlayPosition(opts) {
        const margin = Number.isFinite(opts.margin) ? opts.margin : OVERLAY_VIEWPORT_MARGIN;
        const width = Number.isFinite(opts.width) ? opts.width : OVERLAY_POPUP_WIDTH;
        return {
            left: Math.max(margin, opts.viewportWidth - width - margin),
            top: margin + 12
        };
    }

    /**
     * @param {{ left: number, top: number } | null | undefined} pos
     * @returns {{ left: number, top: number } | null}
     */
    function serializeOverlayPosition(pos) {
        return normalizeOverlayPosition(pos);
    }

    /**
     * Restore a stored position into a clamped on-screen point, or default if invalid.
     * @param {unknown} stored
     * @param {{ width: number, height: number, viewportWidth: number, viewportHeight: number, margin?: number }} box
     */
    function restoreOverlayPosition(stored, box) {
        const normalized = normalizeOverlayPosition(stored);
        if (!normalized) {
            return defaultOverlayPosition({
                width: box.width,
                viewportWidth: box.viewportWidth,
                margin: box.margin
            });
        }
        return clampOverlayPosition(normalized.left, normalized.top, box);
    }

    function getOverlayPositionStorageKey() {
        return POSITION_STORAGE_KEY;
    }

    /**
     * Whether a pointer event target should be ignored for drag initiation.
     * @param {Element | null} target
     * @param {Element | null} dragRoot
     */
    function isInteractiveDragExclusion(target, dragRoot) {
        if (!target || !dragRoot) return true;
        if (!(target instanceof Element)) return true;
        if (!dragRoot.contains(target)) return true;
        const interactive = target.closest(
            'button, a, input, select, textarea, option, label, [role="button"], [role="slider"], [role="link"]'
        );
        return !!(interactive && dragRoot.contains(interactive));
    }

    const api = {
        OVERLAY_POPUP_WIDTH,
        OVERLAY_POPUP_HEIGHT,
        OVERLAY_COLLAPSED_HEIGHT,
        OVERLAY_VIEWPORT_MARGIN,
        normalizeOverlayPosition,
        clampOverlayPosition,
        defaultOverlayPosition,
        serializeOverlayPosition,
        restoreOverlayPosition,
        getOverlayPositionStorageKey,
        isInteractiveDragExclusion
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.KokoroOverlayPosition = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
