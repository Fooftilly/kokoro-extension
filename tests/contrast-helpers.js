/**
 * Shared WCAG contrast helpers for CSS regression tests.
 * Opaque sRGB only — reject #RRGGBBAA.
 */

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

function cssVar(css, selector, name) {
    const block = css.match(new RegExp(selector.replace('.', '\\.') + '\\s*\\{([\\s\\S]*?)\\}'));
    if (!block) return null;
    // Match 3- or 6-digit hex only (not 8-digit with alpha).
    const match = block[1].match(
        new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)(?![0-9a-fA-F])'));
    return match ? match[1] : null;
}

module.exports = { expandHex, relativeLuminance, contrastRatio, cssVar };
