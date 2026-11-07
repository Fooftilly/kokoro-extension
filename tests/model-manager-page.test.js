/**
 * @jest-environment jsdom
 */
jest.mock('../model-data-store.js', () => ({
    ModelDataStore: jest.fn(),
    formatModelSize: bytes => (bytes / 1000000).toFixed(1) + ' MB',
}));
jest.mock('../mediapipe-provider.js', () => ({ MediaPipeKokoroProvider: jest.fn() }));
jest.mock('../onnx-provider.js', () => ({ OnnxKokoroProvider: jest.fn() }));
jest.mock('../pcm-wav.js', () => ({ pcmToWavBlob: jest.fn(() => new Blob(['wav'])) }));

const audio = () => ({ samples: new Float32Array([0.2, -0.2]), sampleRateHz: 24000 });

describe('ONNX model manager English synthesis diagnostics', () => {
    let engine;
    let dictionaryReady;
    beforeEach(async () => {
        jest.resetModules();
        dictionaryReady = true;
        document.body.innerHTML = `
            <div id="modelManager"></div>
            <textarea id="benchmarkText">Hello world.</textarea>
            <input id="benchmarkIpa" value="hɛˈloʊ.">
            <button id="testServer"></button><button id="chooseServer"></button>
            <p id="serverStatus"></p><audio id="serverAudio"></audio>`;
        global.browser = {
            runtime: { getURL: path => 'moz-extension://test/' + (path.startsWith('/') ? path.slice(1) : path) },
            permissions: { request: jest.fn() },
            storage: { local: { remove: jest.fn(), set: jest.fn() },
                sync: { get: jest.fn(), set: jest.fn() } },
        };
        global.caches = { open: jest.fn() };
        global.fetch = jest.fn();
        global.Response = class Response {};
        global.TransformStream = class TransformStream {};
        URL.createObjectURL = jest.fn(() => 'blob:test-audio');
        URL.revokeObjectURL = jest.fn();
        window.KokoroBenchmark = {
            summarizeRuns: jest.fn(() => ({
                synthesisP50Ms: 12, synthesisP95Ms: 15, realTimeFactorP50: 0.2,
            })),
        };
        engine = {
            initialize: jest.fn(async () => {}),
            synthesizePhonemes: jest.fn(async () => audio()),
            synthesize: jest.fn(async () => audio()),
            close: jest.fn(async () => {}),
        };
        require('../onnx-provider.js').OnnxKokoroProvider.mockImplementation(() => engine);
        require('../model-data-store.js').ModelDataStore.mockImplementation(() => ({
            status: jest.fn(async manifest => {
                const ready = (manifest.provider === 'onnx' && manifest.variant === 'q8') ||
                    (manifest.provider === 'dictionary' && dictionaryReady);
                const totalBytes = manifest.assets.reduce((sum, a) => sum + a.bytes, 0);
                return { ready, totalBytes, storedBytes: ready ? totalBytes : 0 };
            }),
        }));
        require('../model-manager-page.js');
        await new Promise(resolve => setTimeout(resolve, 0));
    });

    async function runProbe() {
        const row = document.querySelector('[data-variant="onnx-q8"]');
        const button = row.querySelector('.model-test');
        expect(button.disabled).toBe(false);
        button.click();
        const status = row.querySelector('.model-status');
        for (let i = 0; i < 50; i++) {
            if (status.textContent.includes('Streaming time-to-first-audio')) {
                return { row, message: status.textContent };
            }
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        throw new Error('ONNX probe did not finish: ' + status.textContent);
    }

    test('checks English output separately from IPA measurements without enabling general ONNX', async () => {
        const { row, message } = await runProbe();
        expect(engine.synthesizePhonemes).toHaveBeenCalledTimes(3);
        expect(engine.synthesize).toHaveBeenCalledWith('Hello world.');
        expect(message).toContain('Benchmark used IPA');
        expect(message).toContain('Experimental English text audio is ready');
        expect(row.querySelector('audio').hidden).toBe(false);
        expect(row.querySelector('.model-choose').disabled).toBe(true);
    });

    test('missing dictionary is never downloaded implicitly and IPA remains testable', async () => {
        dictionaryReady = false;
        const { message } = await runProbe();
        expect(engine.synthesizePhonemes).toHaveBeenCalledTimes(3);
        expect(engine.synthesize).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(global.browser.permissions.request).not.toHaveBeenCalled();
        expect(message).toContain('download the pronunciation dictionary first');
    });

    test('an English G2P error leaves the valid IPA audio available', async () => {
        engine.synthesize.mockRejectedValueOnce(new Error('Unknown English word'));
        const { row, message } = await runProbe();
        expect(message).toContain('English text synthesis failed: Unknown English word');
        expect(message).toContain('Playing the IPA probe instead');
        expect(row.querySelector('audio').src).toBe('blob:test-audio');
        expect(row.querySelector('.model-choose').disabled).toBe(true);
    });
});
