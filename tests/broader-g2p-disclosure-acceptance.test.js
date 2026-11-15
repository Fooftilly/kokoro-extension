/** @jest-environment node */
/**
 * Contract for multi-lang / long-form G2P not-measured disclosure (#61 / KE-55).
 * Additive to KE-41b dictionary-gated short English; dual Chromium+Firefox wire.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'broader-g2p-disclosure-acceptance.mjs')).href;
const disclosureModule = require('../broader-g2p-disclosure.js');
const {
    phonemizeEnglish,
    parseEnglishLexicon,
    discloseOnnxEnglishG2pLimits,
} = require('../english-g2p.js');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const disclosureSource = path.join(root, 'broader-g2p-disclosure.js');
const acceptanceSource = path.join(
    root, 'scripts', 'broader-g2p-disclosure-acceptance.mjs');
const buildSource = path.join(root, 'build.js');
const eslintSource = path.join(root, 'eslint.config.mjs');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as broader from ${JSON.stringify(helperUrl)};
const report = broader.buildBroaderG2pDisclosureReport({
    browser: 'chromium',
});
const ok = broader.assertBroaderG2pDisclosure(report);
broader.assertBroaderG2pDisclosureReport(report);
const failMultiLang = (() => {
    try {
        broader.assertBroaderG2pDisclosure({
            ...report,
            multiLangG2pMeasured: true,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failLongForm = (() => {
    try {
        broader.assertBroaderG2pDisclosure({
            ...report,
            longFormPronunciationQualityMeasured: true,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failNotDictOnly = (() => {
    try {
        broader.assertBroaderG2pDisclosure({
            ...report,
            dictionaryGatedShortEnglishOnly: false,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failProbeIncluded = (() => {
    try {
        broader.assertBroaderG2pDisclosure({
            ...report,
            multiLangProbeExcluded: false,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    needle: broader.BROADER_G2P_DISCLOSURE_NEEDLE,
    probe: broader.MULTI_LANG_PROBE_WORD,
    ok, report, failMultiLang, failLongForm, failNotDictOnly, failProbeIncluded,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('Broader G2P disclosure acceptance (KE-55)', () => {
    test('discloseBroaderG2pLimits never claims multi-lang or long-form measured', () => {
        const disclosure = disclosureModule.discloseBroaderG2pLimits();
        expect(disclosure).toEqual({
            multiLangG2pMeasured: false,
            longFormPronunciationQualityMeasured: false,
            dictionaryGatedShortEnglishOnly: true,
            disclosureNeedle: disclosureModule.BROADER_G2P_DISCLOSURE_NEEDLE,
        });
        expect(disclosure.disclosureNeedle).toContain(
            'multi-lang / long-form G2P not measured');
        expect(disclosure.disclosureNeedle).toContain(
            'short English dictionary-gated only');
        expect(disclosureModule.isExcludedFromMeasuredG2pClaims(
            disclosureModule.MULTI_LANG_PROBE_WORD)).toBe(true);
        expect(disclosureModule.isExcludedFromMeasuredG2pClaims('hello')).toBe(false);
    });

    test('KE-41b short-English dictionary path stays fail-closed for OOV', () => {
        const short = discloseOnnxEnglishG2pLimits();
        expect(short.dictionaryGatedEnglish).toBe(true);
        expect(short.broaderG2pMeasured).toBe(false);
        expect(short.oovFailsClosed).toBe(true);
        const lexicon = parseEnglishLexicon('hello HH AH0 L OW1\n');
        expect(() => phonemizeEnglish('zzzzqwertyword.', lexicon))
            .toThrow(/Missing English pronunciation/);
        // Non-English probe is outside measured claims and fail-closes.
        expect(() => phonemizeEnglish(
            disclosureModule.MULTI_LANG_PROBE_WORD + '.', lexicon))
            .toThrow(/Unsupported English text|Missing English pronunciation/);
    });

    test('shared acceptance helper asserts and rejects measured broader claims', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.needle).toBe(
            'multi-lang / long-form G2P not measured; short English dictionary-gated only');
        expect(snap.probe).toBe('привет');
        expect(snap.ok).toEqual(expect.objectContaining({
            success: true,
            multiLangG2pMeasured: false,
            longFormPronunciationQualityMeasured: false,
            dictionaryGatedShortEnglishOnly: true,
            multiLangProbeExcluded: true,
        }));
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            multiLangG2pMeasured: false,
            longFormPronunciationQualityMeasured: false,
            dictionaryGatedShortEnglishOnly: true,
            multiLangProbeExcluded: true,
            multiLangProbeWord: 'привет',
        }));
        expect(snap.failMultiLang.ok).toBe(false);
        expect(snap.failMultiLang.message).toMatch(/Multi-lang G2P/i);
        expect(snap.failLongForm.ok).toBe(false);
        expect(snap.failLongForm.message).toMatch(/Long-form pronunciation/i);
        expect(snap.failNotDictOnly.ok).toBe(false);
        expect(snap.failNotDictOnly.message).toMatch(/dictionary-gated short English/i);
        expect(snap.failProbeIncluded.ok).toBe(false);
        expect(snap.failProbeIncluded.message).toMatch(/excluded from measured/i);
    });

    test('needles stay aligned between disclosure source and acceptance module', () => {
        const disclosure = fs.readFileSync(disclosureSource, 'utf8');
        const acceptance = fs.readFileSync(acceptanceSource, 'utf8');
        const needle =
            'multi-lang / long-form G2P not measured; short English dictionary-gated only';
        expect(disclosure).toContain(needle);
        expect(acceptance).toContain(needle);
        expect(disclosure).toContain('discloseBroaderG2pLimits');
        expect(disclosure).toContain('multiLangG2pMeasured: false');
        expect(disclosure).toContain('longFormPronunciationQualityMeasured: false');
        expect(disclosure).toContain('dictionaryGatedShortEnglishOnly: true');
        expect(acceptance).toContain('assertBroaderG2pDisclosure');
        expect(acceptance).toContain('buildBroaderG2pDisclosureReport');
    });

    test('source wiring: build/eslint + dual live Chromium and Firefox asserts', () => {
        const firefox = fs.readFileSync(firefoxLive, 'utf8');
        const chromium = fs.readFileSync(chromiumLive, 'utf8');
        const build = fs.readFileSync(buildSource, 'utf8');
        const eslint = fs.readFileSync(eslintSource, 'utf8');

        expect(build).toContain("'broader-g2p-disclosure.js'");
        expect(eslint).toContain("'broader-g2p-disclosure.js'");

        expect(firefox).toContain('broader-g2p-disclosure-acceptance.mjs');
        expect(firefox).toContain('assert_broader_g2p_disclosure');
        expect(firefox).toContain('broaderG2pDisclosureAcceptance');
        const firefoxCall = firefox.indexOf(
            'assert_broader_g2p_disclosure(\n                    browser="Firefox")');
        const firefoxGpu = firefox.indexOf('assert_gpu_execution_disclosure(');
        const firefoxPopup = firefox.indexOf(
            'accept_popup_test_tts_cta(driver, state["origin"])');
        expect(firefoxGpu).toBeGreaterThan(0);
        expect(firefoxCall).toBeGreaterThan(firefoxGpu);
        expect(firefoxPopup).toBeGreaterThan(firefoxCall);

        expect(chromium).toContain('broader-g2p-disclosure-acceptance.mjs');
        expect(chromium).toContain('assertBroaderG2pDisclosure');
        expect(chromium).toContain('assertBroaderG2pDisclosureReport');
        expect(chromium).toContain('buildBroaderG2pDisclosureReport');
        expect(chromium).toContain('broaderG2pDisclosureAcceptance');
        expect(chromium).toContain('MULTI_LANG_PROBE_WORD');
        const chromiumDualGate = chromium.indexOf(
            "providerFilter === 'both' && !originDownload");
        const chromiumGpu = chromium.indexOf(
            'assertGpuExecutionDisclosure(preflight)');
        const chromiumBroader = chromium.indexOf(
            'assertBroaderG2pDisclosureReport(broaderG2pDisclosureAcceptance)');
        const chromiumPopup = chromium.indexOf(
            'liveHeartbeat(\'popup-test-tts-cta-start\')');
        expect(chromiumDualGate).toBeGreaterThan(0);
        expect(chromiumGpu).toBeGreaterThan(chromiumDualGate);
        expect(chromiumBroader).toBeGreaterThan(chromiumGpu);
        expect(chromiumPopup).toBeGreaterThan(chromiumBroader);
    });
});
