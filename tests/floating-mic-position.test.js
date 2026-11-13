/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

const {
    FLOAT_MIC_BTN_SIZE,
    FLOAT_MIC_MARGIN,
    FLOAT_MIC_SELECTION_THROTTLE_MS,
    normalizeClientRect,
    isSelectionBackward,
    getSelectionEndClientRect,
    getSelectionFocusClientRect,
    preferredFloatingMicPosition,
    clampFloatingMicPosition,
    computeFloatingMicPosition
} = require('../floating-mic-position.js');

function rect(partial) {
    return {
        top: 0,
        left: 0,
        bottom: 0,
        right: 0,
        width: 0,
        height: 0,
        ...partial
    };
}

describe('floating-mic-position helpers', () => {
    test('exports sizing / throttle constants', () => {
        expect(FLOAT_MIC_BTN_SIZE).toBe(36);
        expect(FLOAT_MIC_MARGIN).toBe(10);
        expect(FLOAT_MIC_SELECTION_THROTTLE_MS).toBe(100);
    });

    test('normalizeClientRect copies finite box values and rejects invalid', () => {
        expect(normalizeClientRect(rect({ top: 10, left: 20, bottom: 30, right: 40, width: 20, height: 20 })))
            .toEqual({ top: 10, left: 20, bottom: 30, right: 40, width: 20, height: 20 });
        expect(normalizeClientRect(null)).toBeNull();
        expect(normalizeClientRect(rect({ top: NaN, left: 1, bottom: 2, right: 3 }))).toBeNull();
        expect(normalizeClientRect(rect({ top: Infinity, left: 1, bottom: 2, right: 3 }))).toBeNull();
    });

    test('getSelectionEndClientRect collapses to end before reading caret rect', () => {
        const wholeRect = rect({
            top: 100, left: 10, bottom: 216, right: 300, width: 290, height: 116
        });
        const caretRect = rect({
            top: 200, left: 50, bottom: 216, right: 50, width: 0, height: 16
        });
        let collapsedTo = null;
        const range = {
            cloneRange() {
                return {
                    collapse(toStart) {
                        collapsedTo = toStart;
                    },
                    getBoundingClientRect: () => (
                        collapsedTo === false ? caretRect : wholeRect
                    )
                };
            },
            getClientRects: () => [
                rect({ top: 100, left: 10, bottom: 116, right: 300, width: 290, height: 16 }),
                rect({ top: 200, left: 10, bottom: 216, right: 80, width: 70, height: 16 })
            ],
            getBoundingClientRect: () => wholeRect
        };

        const end = getSelectionEndClientRect(range);
        expect(collapsedTo).toBe(false);
        expect(end).toEqual(caretRect);
        expect(end.top).not.toBe(100);
        expect(end.right).not.toBe(300);
    });

    test('getSelectionEndClientRect falls back to last client rect then whole range', () => {
        const last = rect({ top: 180, left: 12, bottom: 196, right: 90, width: 78, height: 16 });
        const whole = rect({ top: 80, left: 12, bottom: 196, right: 400, width: 388, height: 116 });

        const viaClientRects = {
            cloneRange() {
                return {
                    collapse() {},
                    getBoundingClientRect: () => rect({ top: 0, left: 0, bottom: 0, right: 0 })
                };
            },
            getClientRects: () => [
                rect({ top: 80, left: 12, bottom: 96, right: 400, width: 388, height: 16 }),
                last
            ],
            getBoundingClientRect: () => whole
        };
        expect(getSelectionEndClientRect(viaClientRects)).toEqual(last);

        const viaWhole = {
            cloneRange() {
                return {
                    collapse() {},
                    getBoundingClientRect: () => rect({ top: 0, left: 0, bottom: 0, right: 0 })
                };
            },
            getClientRects: () => [],
            getBoundingClientRect: () => whole
        };
        expect(getSelectionEndClientRect(viaWhole)).toEqual(whole);
        expect(getSelectionEndClientRect(null)).toBeNull();
    });

    test('isSelectionBackward detects setBaseAndExtent-style reverse focus', () => {
        const textNode = { nodeType: 3 };
        expect(isSelectionBackward({
            isCollapsed: false,
            anchorNode: textNode,
            anchorOffset: 5,
            focusNode: textNode,
            focusOffset: 1
        })).toBe(true);
        expect(isSelectionBackward({
            isCollapsed: false,
            anchorNode: textNode,
            anchorOffset: 1,
            focusNode: textNode,
            focusOffset: 5
        })).toBe(false);
    });

    test('getSelectionFocusClientRect uses focusNode/focusOffset, not range end (backward)', () => {
        // Mirrors Chromium: selection.setBaseAndExtent(textNode, 5, textNode, 1)
        // → focusOffset === 1, while range.endOffset === 5 (document-order end).
        const textNode = { nodeType: 3 };
        const focusCaret = rect({
            top: 40, left: 12, bottom: 56, right: 12, width: 0, height: 16
        });
        const rangeEndCaret = rect({
            top: 40, left: 90, bottom: 56, right: 90, width: 0, height: 16
        });
        let setStartArgs = null;
        let collapsedAfterSetStart = false;

        const range = {
            startContainer: textNode,
            startOffset: 1,
            endContainer: textNode,
            endOffset: 5,
            cloneRange() {
                return {
                    setStart(node, offset) {
                        setStartArgs = { node, offset };
                        collapsedAfterSetStart = false;
                    },
                    collapse(toStart) {
                        if (setStartArgs && toStart === true) {
                            collapsedAfterSetStart = true;
                        }
                    },
                    getBoundingClientRect() {
                        if (collapsedAfterSetStart &&
                            setStartArgs &&
                            setStartArgs.node === textNode &&
                            setStartArgs.offset === 1) {
                            return focusCaret;
                        }
                        return rangeEndCaret;
                    }
                };
            },
            getClientRects: () => [focusCaret, rangeEndCaret],
            getBoundingClientRect: () => rect({
                top: 40, left: 12, bottom: 56, right: 90, width: 78, height: 16
            })
        };

        const selection = {
            rangeCount: 1,
            getRangeAt: () => range,
            isCollapsed: false,
            anchorNode: textNode,
            anchorOffset: 5,
            focusNode: textNode,
            focusOffset: 1
        };

        const box = getSelectionFocusClientRect(selection);
        expect(setStartArgs).toEqual({ node: textNode, offset: 1 });
        expect(collapsedAfterSetStart).toBe(true);
        expect(box).toEqual(focusCaret);
        expect(box.left).not.toBe(rangeEndCaret.left);
    });

    test('preferredFloatingMicPosition places control above/right of end caret', () => {
        const endRect = rect({ top: 200, left: 100, bottom: 216, right: 140, width: 40, height: 16 });
        expect(preferredFloatingMicPosition(endRect)).toEqual({
            left: 140 - FLOAT_MIC_BTN_SIZE / 2,
            top: 200 - FLOAT_MIC_BTN_SIZE - FLOAT_MIC_MARGIN
        });
    });

    test('preferredFloatingMicPosition flips below when above would clip the top', () => {
        const endRect = rect({ top: 8, left: 40, bottom: 24, right: 80, width: 40, height: 16 });
        const pos = preferredFloatingMicPosition(endRect);
        expect(pos.top).toBe(24 + FLOAT_MIC_MARGIN);
        expect(pos.left).toBe(80 - FLOAT_MIC_BTN_SIZE / 2);
    });

    test('clampFloatingMicPosition clamps all four viewport edges', () => {
        const box = {
            btnSize: FLOAT_MIC_BTN_SIZE,
            margin: FLOAT_MIC_MARGIN,
            viewportWidth: 400,
            viewportHeight: 300
        };
        expect(clampFloatingMicPosition(-50, -20, box)).toEqual({
            left: FLOAT_MIC_MARGIN,
            top: FLOAT_MIC_MARGIN
        });
        expect(clampFloatingMicPosition(500, 400, box)).toEqual({
            left: 400 - FLOAT_MIC_BTN_SIZE - FLOAT_MIC_MARGIN,
            top: 300 - FLOAT_MIC_BTN_SIZE - FLOAT_MIC_MARGIN
        });
        expect(clampFloatingMicPosition(100, 120, box)).toEqual({ left: 100, top: 120 });
    });

    test('computeFloatingMicPosition clamps preferred end-caret coords at right/bottom', () => {
        // endRect.right=390 → preferred left = 390 - 18 = 372 → clamp to 400-36-10 = 354
        // endRect.top=280 → preferred top = 280 - 36 - 10 = 234 (fits); stay 234
        const endRect = rect({
            top: 280, left: 360, bottom: 296, right: 390, width: 30, height: 16
        });
        const pos = computeFloatingMicPosition(endRect, {
            viewportWidth: 400,
            viewportHeight: 300
        });
        expect(pos).toEqual({
            left: 400 - FLOAT_MIC_BTN_SIZE - FLOAT_MIC_MARGIN,
            top: 280 - FLOAT_MIC_BTN_SIZE - FLOAT_MIC_MARGIN
        });
    });

    test('computeFloatingMicPosition returns null without a usable end rect', () => {
        expect(computeFloatingMicPosition(null, {
            viewportWidth: 800,
            viewportHeight: 600
        })).toBeNull();
    });
});

describe('content.js floating mic survival contract (#11)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

    test('uses fixed positioning helpers and throttled selectionchange', () => {
        expect(source).toContain('KokoroFloatingMicPosition');
        expect(source).toContain("position = 'fixed'");
        expect(source).toContain("addEventListener('selectionchange'");
        expect(source).toContain('scheduleSelectionHandle');
        expect(source).toContain('getSelectionFocusClientRect');
        expect(source).toContain('computeFloatingMicPosition');
        expect(source).toContain('scheduleFloatingMicReposition');
        expect(source).toContain('storage.onChanged');
        expect(source).toContain("addEventListener('resize'");
    });

    test('scroll follows selection instead of dismissing the control', () => {
        expect(source).toMatch(/addEventListener\('scroll'[\s\S]*scheduleFloatingMicReposition\(\)/);
        expect(source).not.toMatch(/addEventListener\('scroll'[\s\S]*removeFloatingButton\(\)/);
        expect(source).toMatch(/Survival rule:[\s\S]*follows the selection focus endpoint/);
        expect(source).toMatch(/void handleSelection\(\)/);
    });
});
