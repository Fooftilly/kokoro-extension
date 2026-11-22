/**
 * Regression: #212 setup CTA hover must meet WCAG AA contrast.
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');

function expandHex(hex) {
    const h = hex.replace('#', '');
    if (h.length === 3) return h.split('').map((c) => c + c).join('');
    if (h.length === 6) return h;
    throw new Error('Expected opaque #RGB or #RRGGBB, got ' + hex);
}

function relativeLuminance(hex) {
    const h = expandHex(hex);
    const channels = [0, 2, 4].map((i) => {
        const c = parseInt(h.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(fg, bg) {
    const [lo, hi] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => a - b);
    return (hi + 0.05) / (lo + 0.05);
}

describe('popup secondary-btn hover contrast (#212)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../popup.css'), 'utf8');

    test('secondary-btn:hover uses white on #0056b3 (≥4.5:1)', () => {
        const hover = css.match(/\.secondary-btn:hover\s*\{([\s\S]*?)\}/);
        expect(hover).toBeTruthy();
        // Require the `color` property (not a substring of `border-color`).
        const fg = hover[1].match(/(?:^|[;\n\r])\s*color:\s*(#[0-9a-fA-F]{3,6})\b/);
        const bg = hover[1].match(/(?:^|[;\n\r])\s*background:\s*(#[0-9a-fA-F]{3,6})\b/);
        expect(fg).toBeTruthy();
        expect(bg).toBeTruthy();
        expect(expandHex(fg[1]).toLowerCase()).toBe('ffffff');
        expect(expandHex(bg[1]).toLowerCase()).toBe('0056b3');
        expect(contrastRatio(fg[1], bg[1])).toBeGreaterThanOrEqual(4.5);
        // Guard: border-color alone must not satisfy the text-color check.
        expect('border-color: #fff;').not.toMatch(/(?:^|[;\n\r])\s*color:\s*#[0-9a-fA-F]{3,6}\b/);
    });

    test('generic button:hover alone would fail AA with light-theme text', () => {
        // Documents why .secondary-btn:hover must override color.
        expect(contrastRatio('#333333', '#0056b3')).toBeLessThan(4.5);
    });
});
