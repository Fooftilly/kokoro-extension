/**
 * @jest-environment jsdom
 */

const {
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
} = require('../overlay-position.js');

describe('overlay-position helpers', () => {
    test('normalizeOverlayPosition accepts finite left/top and rejects invalid', () => {
        expect(normalizeOverlayPosition({ left: 10, top: 20 })).toEqual({ left: 10, top: 20 });
        expect(normalizeOverlayPosition({ left: '12', top: '8' })).toEqual({ left: 12, top: 8 });
        expect(normalizeOverlayPosition(null)).toBeNull();
        expect(normalizeOverlayPosition({})).toBeNull();
        expect(normalizeOverlayPosition({ left: NaN, top: 1 })).toBeNull();
        expect(normalizeOverlayPosition({ left: Infinity, top: 1 })).toBeNull();
        expect(normalizeOverlayPosition('nope')).toBeNull();
    });

    test('serializeOverlayPosition mirrors normalize', () => {
        expect(serializeOverlayPosition({ left: 5, top: 6 })).toEqual({ left: 5, top: 6 });
        expect(serializeOverlayPosition({ left: 'x', top: 1 })).toBeNull();
    });

    test('clampOverlayPosition keeps player inside viewport', () => {
        const box = {
            width: OVERLAY_POPUP_WIDTH,
            height: OVERLAY_POPUP_HEIGHT,
            viewportWidth: 1000,
            viewportHeight: 800,
            margin: OVERLAY_VIEWPORT_MARGIN
        };
        expect(clampOverlayPosition(-100, -50, box)).toEqual({
            left: OVERLAY_VIEWPORT_MARGIN,
            top: OVERLAY_VIEWPORT_MARGIN
        });
        expect(clampOverlayPosition(900, 700, box)).toEqual({
            left: 1000 - OVERLAY_POPUP_WIDTH - OVERLAY_VIEWPORT_MARGIN,
            top: 800 - OVERLAY_POPUP_HEIGHT - OVERLAY_VIEWPORT_MARGIN
        });
        expect(clampOverlayPosition(100, 120, box)).toEqual({ left: 100, top: 120 });
    });

    test('clampOverlayPosition pins when viewport is smaller than player', () => {
        const box = {
            width: OVERLAY_POPUP_WIDTH,
            height: OVERLAY_POPUP_HEIGHT,
            viewportWidth: 200,
            viewportHeight: 100,
            margin: OVERLAY_VIEWPORT_MARGIN
        };
        expect(clampOverlayPosition(-40, 999, box)).toEqual({
            left: OVERLAY_VIEWPORT_MARGIN,
            top: OVERLAY_VIEWPORT_MARGIN
        });
    });

    test('clamp uses collapsed height when provided', () => {
        const box = {
            width: OVERLAY_POPUP_WIDTH,
            height: OVERLAY_COLLAPSED_HEIGHT,
            viewportWidth: 400,
            viewportHeight: 300,
            margin: 8
        };
        const clamped = clampOverlayPosition(350, 280, box);
        expect(clamped.left).toBe(400 - OVERLAY_POPUP_WIDTH - 8);
        expect(clamped.top).toBe(300 - OVERLAY_COLLAPSED_HEIGHT - 8);
    });

    test('defaultOverlayPosition is top-right-ish', () => {
        const pos = defaultOverlayPosition({ viewportWidth: 1000, width: OVERLAY_POPUP_WIDTH });
        expect(pos.left).toBe(1000 - OVERLAY_POPUP_WIDTH - OVERLAY_VIEWPORT_MARGIN);
        expect(pos.top).toBe(OVERLAY_VIEWPORT_MARGIN + 12);
    });

    test('restoreOverlayPosition clamps valid storage and defaults invalid', () => {
        const box = {
            width: OVERLAY_POPUP_WIDTH,
            height: OVERLAY_POPUP_HEIGHT,
            viewportWidth: 900,
            viewportHeight: 700
        };
        expect(restoreOverlayPosition({ left: 50, top: 60 }, box)).toEqual({ left: 50, top: 60 });
        expect(restoreOverlayPosition({ left: -200, top: 10 }, box)).toEqual({
            left: OVERLAY_VIEWPORT_MARGIN,
            top: 10
        });
        expect(restoreOverlayPosition(undefined, box)).toEqual(
            defaultOverlayPosition({ viewportWidth: 900, width: OVERLAY_POPUP_WIDTH })
        );
        expect(restoreOverlayPosition({ left: 'bad' }, box)).toEqual(
            defaultOverlayPosition({ viewportWidth: 900, width: OVERLAY_POPUP_WIDTH })
        );
    });

    test('storage key is local-geometry scoped', () => {
        expect(getOverlayPositionStorageKey()).toBe('kokoroOverlayPosition');
    });

    test('isInteractiveDragExclusion blocks controls inside drag root', () => {
        document.body.innerHTML = `
            <div id="root">
                <span id="grip">move</span>
                <button id="btn">x</button>
                <input id="vol" type="range" />
            </div>
        `;
        const root = document.getElementById('root');
        expect(isInteractiveDragExclusion(document.getElementById('grip'), root)).toBe(false);
        expect(isInteractiveDragExclusion(document.getElementById('btn'), root)).toBe(true);
        expect(isInteractiveDragExclusion(document.getElementById('vol'), root)).toBe(true);
        expect(isInteractiveDragExclusion(null, root)).toBe(true);
        expect(isInteractiveDragExclusion(document.body, root)).toBe(true);
    });

    test('compact vs full geometry constants stay separated', () => {
        expect(OVERLAY_COLLAPSED_HEIGHT).toBeLessThan(OVERLAY_POPUP_HEIGHT);
        expect(OVERLAY_POPUP_WIDTH).toBe(320);
        expect(OVERLAY_POPUP_HEIGHT).toBe(500);
    });
});
