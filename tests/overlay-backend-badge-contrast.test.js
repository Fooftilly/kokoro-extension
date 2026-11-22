/**
 * Regression: #194 backend badge must meet WCAG AA contrast on header bg.
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');

function relativeLuminance(hex) {
    const h = hex.replace('#', '');
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

function cssVar(css, selector, name) {
    const block = css.match(new RegExp(selector.replace('.', '\\.') + '\\s*\\{([\\s\\S]*?)\\}'));
    expect(block).toBeTruthy();
    const match = block[1].match(new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{3,8})'));
    expect(match).toBeTruthy();
    return match[1];
}

describe('overlay backend badge contrast (#194 / #210 review)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../overlay.css'), 'utf8');

    test('light and dark badge text meet WCAG AA (≥4.5:1) on header background', () => {
        const lightBg = cssVar(css, ':root', 'header-bg');
        const lightFg = cssVar(css, ':root', 'backend-badge-text');
        const darkBg = cssVar(css, '.dark-theme', 'header-bg');
        const darkFg = cssVar(css, '.dark-theme', 'backend-badge-text');

        expect(contrastRatio(lightFg, lightBg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(darkFg, darkBg)).toBeGreaterThanOrEqual(4.5);
        expect(css).toMatch(/\.backend-badge\s*\{[\s\S]*color:\s*var\(--backend-badge-text\)/);
    });
});
