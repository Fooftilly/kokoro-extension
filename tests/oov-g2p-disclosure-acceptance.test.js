/** @jest-environment node */
/**
 * Contract for ONNX dictionary-gated OOV / G2P disclosure (#61 / KE-41b).
 * Broader long-form G2P is not claimed; dual Chromium must wire the assert.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const helperUrl = pathToFileURL(
    path.join(root, 'scripts', 'oov-g2p-disclosure-acceptance.mjs')).href;
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const englishG2p = path.join(root, 'english-g2p.js');

function loadHelperSnapshot() {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as oov from ${JSON.stringify(helperUrl)};
const ok = oov.assertOnnxOovG2pDisclosure({
    dictionaryGatedEnglish: true,
    broaderG2pMeasured: false,
    oovFailsClosed: true,
    disclosureNeedle: oov.ONNX_ENGLISH_G2P_DISCLOSURE_NEEDLE,
    unknownWordsRejected: true,
});
const report = oov.buildOovG2pDisclosureReport({
    browser: 'chromium',
    unknownWordsRejected: true,
    ipaOnlyExcluded: true,
});
oov.assertOovG2pDisclosureReport(report);
const failBroader = (() => {
    try {
        oov.assertOnnxOovG2pDisclosure({
            dictionaryGatedEnglish: true,
            broaderG2pMeasured: true,
            oovFailsClosed: true,
            disclosureNeedle: oov.ONNX_ENGLISH_G2P_DISCLOSURE_NEEDLE,
            unknownWordsRejected: true,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
const failNoReject = (() => {
    try {
        oov.assertOnnxOovG2pDisclosure({
            dictionaryGatedEnglish: true,
            broaderG2pMeasured: false,
            oovFailsClosed: true,
            disclosureNeedle: oov.ONNX_ENGLISH_G2P_DISCLOSURE_NEEDLE,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, message: String(error.message || error) };
    }
})();
console.log(JSON.stringify({
    needle: oov.ONNX_ENGLISH_G2P_DISCLOSURE_NEEDLE,
    probe: oov.OOV_PROBE_WORD,
    ok, report, failBroader, failNoReject,
}));
`], { encoding: 'utf8', cwd: root });
}

describe('OOV / G2P disclosure acceptance (KE-41b)', () => {
    test('english-g2p helpers disclose dictionary gating and list OOV words', () => {
        const {
            discloseOnnxEnglishG2pLimits,
            listUnsupportedEnglishWords,
            parseEnglishLexicon,
            ONNX_ENGLISH_G2P_DISCLOSURE_NEEDLE,
        } = require('../english-g2p.js');
        const disclosure = discloseOnnxEnglishG2pLimits();
        expect(disclosure).toEqual({
            dictionaryGatedEnglish: true,
            broaderG2pMeasured: false,
            oovFailsClosed: true,
            disclosureNeedle: ONNX_ENGLISH_G2P_DISCLOSURE_NEEDLE,
        });
        expect(disclosure.disclosureNeedle).toContain('dictionary-gated');
        expect(disclosure.disclosureNeedle).toContain('broader G2P not measured');
        const lexicon = parseEnglishLexicon('hello HH AH0 L OW1\nworld W ER1 L D\n');
        expect(listUnsupportedEnglishWords('Hello zzzzqwertyword.', lexicon))
            .toEqual(['zzzzqwertyword']);
        expect(listUnsupportedEnglishWords('Hello world.', lexicon)).toEqual([]);
        // Digits/emoji must not truncate the diagnostic OOV scan (Devin P2).
        expect(listUnsupportedEnglishWords('Hello 2 zzzzqwertyword.', lexicon))
            .toEqual(['zzzzqwertyword']);
        expect(listUnsupportedEnglishWords('Hello 😀 zzzzqwertyword.', lexicon))
            .toEqual(['zzzzqwertyword']);
        expect(() => listUnsupportedEnglishWords('hi', null))
            .toThrow(/dictionary are required/);
    });

    test('shared acceptance helper validates flags and rejects broader-G2P claims', () => {
        const child = loadHelperSnapshot();
        expect(child.status).toBe(0);
        expect(child.stderr || '').toBe('');
        const snap = JSON.parse(child.stdout.trim());
        expect(snap.needle).toContain('dictionary-gated');
        expect(snap.probe).toBe('zzzzqwertyword');
        expect(snap.ok).toBe(true);
        expect(snap.report).toEqual(expect.objectContaining({
            success: true,
            dictionaryGatedEnglish: true,
            broaderG2pMeasured: false,
            oovFailsClosed: true,
            unknownWordsRejected: true,
            ipaOnlyExcluded: true,
        }));
        expect(snap.failBroader.ok).toBe(false);
        expect(snap.failBroader.message).toMatch(/Broader long-form G2P/i);
        expect(snap.failNoReject.ok).toBe(false);
        expect(snap.failNoReject.message).toMatch(/unknownWordsRejected|ipaOnlyExcluded/i);
    });

    test('disclosure needles stay aligned between english-g2p and acceptance module', () => {
        const g2p = fs.readFileSync(englishG2p, 'utf8');
        const acceptance = fs.readFileSync(
            path.join(root, 'scripts', 'oov-g2p-disclosure-acceptance.mjs'), 'utf8');
        const needle =
            'dictionary-gated English; OOV fails closed; broader G2P not measured';
        expect(g2p).toContain(needle);
        expect(acceptance).toContain(needle);
        expect(g2p).toContain('discloseOnnxEnglishG2pLimits');
        expect(g2p).toContain('listUnsupportedEnglishWords');
    });

    test('Chromium dual wires OOV disclosure after Use this backend', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toContain("from './oov-g2p-disclosure-acceptance.mjs'");
        expect(source).toContain('oovG2pDisclosureAcceptance');
        expect(source).toContain('acceptOnnxOovG2pDisclosureOnBenchmark');
        expect(source).toContain('assertOnnxOovG2pDisclosure');
        expect(source).toContain('assertOovG2pDisclosureReport');
        expect(source).toContain('OOV_PROBE_WORD');
        expect(source).toContain('listUnsupportedEnglishWords');
        expect(source).toContain('discloseOnnxEnglishG2pLimits');
        expect(source).toContain('unknownWordsRejected: true');
        expect(source).toContain('OOV_FAIL_CLOSED_NEEDLE');
        expect(source).toContain('listedAfterDigit');
        // Fail-closed must remain — do not weaken the AudioManager reject.
        expect(source).toMatch(
            /Missing English pronunciation\|Unsupported English text/);
        const dualCall = source.indexOf(
            'await acceptOnnxOovG2pDisclosureOnBenchmark(page)');
        const dualChoose = source.indexOf(
            'Use this backend did not select MediaPipe');
        const dualReturn = source.indexOf(
            'measuredResultsExport, oovG2pDisclosureAcceptance');
        expect(dualCall).toBeGreaterThan(dualChoose);
        expect(dualReturn).toBeGreaterThan(dualCall);
        expect(source).toContain('oovDisclosure: disclosure');
        expect(source).toContain(
            'strengthen fail-closed with shared dictionary-gated disclosure');
    });
});
