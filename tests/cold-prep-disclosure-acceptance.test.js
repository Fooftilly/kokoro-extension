/** @jest-environment node */
/**
 * Contract for dual-scope cold prep vs warm disclosure (#61 / KE-31).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const chromiumLive = path.join(root, 'scripts', 'validate-live-chromium.mjs');
const firefoxLive = path.join(root, 'scripts', 'validate-live-firefox.py');
const modelManager = path.join(root, 'model-manager-page.js');
const benchmarkHtml = path.join(root, 'benchmark.html');

describe('Cold prep disclosure acceptance', () => {
    test('benchmark UI discloses cold prep separately from warm columns', () => {
        const html = fs.readFileSync(benchmarkHtml, 'utf8');
        const source = fs.readFileSync(modelManager, 'utf8');
        expect(html).toContain('>Cold prep<');
        expect(html).toContain('Cold prep is initialize plus the first untimed synthesis');
        expect(source).toContain('coldPrepMs');
        expect(source).toContain('coldPrepMeasured: true');
        expect(source).toContain('Cold prep (init + first synth)');
        expect(source).toContain('cold prep + three warm runs each');
        expect(source).toContain('coldStartedAt');
        expect(source).not.toMatch(/firstAudioMs:\s*elapsed/);
    });

    test('Chromium dual harness expects cold prep metric cells', () => {
        const source = fs.readFileSync(chromiumLive, 'utf8');
        expect(source).toContain('coldPrepMs: values[0]');
        expect(source).toContain('coldPrepMs: numbers[0]');
        expect(source).toContain('values.length !== 4');
        expect(source).toContain('numbers.length !== 4');
    });

    test('Firefox dual harness expects cold prep metric cells', () => {
        const source = fs.readFileSync(firefoxLive, 'utf8');
        expect(source).toContain('coldPrepMs:values[0]');
        expect(source).toContain('values.length!==4');
        expect(source).toContain('values[2]<values[1]');
    });
});
