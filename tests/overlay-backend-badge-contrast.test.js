/**
 * Regression: #194 backend badge must meet WCAG AA contrast on header bg.
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');
const { expandHex, contrastRatio, cssVar } = require('./contrast-helpers.js');

describe('overlay backend badge contrast (#194 / #210 review)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../overlay.css'), 'utf8');

    test('light and dark badge text meet WCAG AA (≥4.5:1) on header background', () => {
        const lightBg = cssVar(css, ':root', 'header-bg');
        const lightFg = cssVar(css, ':root', 'backend-badge-text');
        const darkBg = cssVar(css, '.dark-theme', 'header-bg');
        const darkFg = cssVar(css, '.dark-theme', 'backend-badge-text');
        expect(lightBg).toBeTruthy();
        expect(lightFg).toBeTruthy();
        expect(darkBg).toBeTruthy();
        expect(darkFg).toBeTruthy();

        expect(contrastRatio(lightFg, lightBg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(darkFg, darkBg)).toBeGreaterThanOrEqual(4.5);
        expect(css).toMatch(/\.backend-badge\s*\{[\s\S]*color:\s*var\(--backend-badge-text\)/);
    });

    test('rejects transparent eight-digit hex instead of treating it as opaque', () => {
        expect(() => contrastRatio('#bbbbbb00', '#2d2d2d')).toThrow(/opaque/);
        expect(() => expandHex('#bbbbbb00')).toThrow(/opaque/);
    });
});
