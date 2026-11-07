/**
 * @jest-environment jsdom
 */
const fs = require('fs');
const path = require('path');

function mountPage() {
    const html = fs.readFileSync(path.join(__dirname, '../benchmark.html'), 'utf8');
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    document.body.innerHTML = body ? body[1] : html;
}

describe('extension-owned browser preflight page (#53)', () => {
    let originalFetch;

    beforeEach(() => {
        jest.resetModules();
        originalFetch = global.fetch;
        global.fetch = jest.fn(() => Promise.reject(new Error('Unexpected network request')));
        mountPage();
        window.KokoroBenchmark = {
            inspectCapabilities: jest.fn(async () => ({
                kind: 'capability-preflight',
                inferenceValidated: false,
                webgpu: { status: 'no-adapter' },
            })),
        };
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: jest.fn(async () => {}) },
        });
        require('../benchmark-page.js');
    });

    afterEach(() => {
        global.fetch = originalFetch;
        delete window.KokoroBenchmark;
    });

    test('does nothing until user explicitly checks browser capabilities', async () => {
        expect(global.fetch).not.toHaveBeenCalled();
        expect(window.KokoroBenchmark.inspectCapabilities).not.toHaveBeenCalled();
        const button = document.getElementById('runCheck');
        button.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(window.KokoroBenchmark.inspectCapabilities).toHaveBeenCalledTimes(1);
        expect(document.getElementById('status').textContent).toMatch(/preflight complete/);
        expect(document.getElementById('report').textContent).toMatch(/"inferenceValidated": false/);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('copy works only after inspection and never uploads report', async () => {
        const copy = document.getElementById('copyCheck');
        expect(copy.disabled).toBe(true);
        document.getElementById('runCheck').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(copy.disabled).toBe(false);
        copy.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('capability-preflight'));
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('WebGPU probe failure remains visible without marking inference validated', async () => {
        window.KokoroBenchmark.inspectCapabilities.mockRejectedValue(new Error('GPU device lost'));
        document.getElementById('runCheck').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(document.getElementById('status').textContent).toMatch(/GPU device lost/);
        expect(document.getElementById('copyCheck').disabled).toBe(true);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
