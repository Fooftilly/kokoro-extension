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
    let installedModels;
    let partialModels;
    let installModel;
    let removeModel;
    let delayedCpuStatus;
    beforeEach(async () => {
        jest.resetModules();
        dictionaryReady = true;
        installedModels = new Set();
        partialModels = new Set();
        installModel = jest.fn();
        removeModel = jest.fn();
        delayedCpuStatus = null;
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
                if (delayedCpuStatus && manifest.provider === 'mediapipe' &&
                    manifest.variant === 'cpu') await delayedCpuStatus;
                const ready = (manifest.provider === 'onnx' && manifest.variant === 'q8') ||
                    (manifest.provider === 'dictionary' && dictionaryReady) ||
                    (manifest.provider === 'mediapipe' && installedModels.has(manifest.variant));
                const totalBytes = manifest.assets.reduce((sum, a) => sum + a.bytes, 0);
                return { ready, totalBytes, storedBytes: ready ? totalBytes :
                    partialModels.has(manifest.provider + '-' + manifest.variant) ? 4 : 0 };
            }),
            install: installModel,
            remove: removeModel,
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

    async function waitFor(predicate) {
        for (let i = 0; i < 50; i++) {
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        throw new Error('Download UI did not reach expected state');
    }

    test('shows indeterminate progress before bytes arrive, then bytes and 100% only after install', async () => {
        global.browser.permissions.request.mockResolvedValue(true);
        let onProgress;
        let finishInstall;
        installModel.mockImplementation((manifest, options) => {
            onProgress = options.onProgress;
            return new Promise(resolve => { finishInstall = resolve; });
        });
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const button = row.querySelector('.model-download');
        const progress = row.querySelector('progress');
        expect(progress.hidden).toBe(true);
        button.click();
        await waitFor(() => installModel.mock.calls.length === 1);
        expect(progress.hidden).toBe(false);
        expect(progress.hasAttribute('value')).toBe(false);
        expect(progress.getAttribute('aria-label')).toContain('MediaPipe CPU');
        expect(button.textContent).toBe('Cancel download');
        const totalBytes = 294783298;
        onProgress({ completedBytes: totalBytes / 2, totalBytes });
        expect(progress.value).toBe(50);
        expect(row.querySelector('.model-status').textContent).toContain('(50%)');
        onProgress({ completedBytes: totalBytes, totalBytes });
        expect(progress.value).toBe(99);
        installedModels.add('cpu');
        finishInstall();
        await waitFor(() => progress.value === 100);
        expect(progress.hidden).toBe(false);
        expect(row.querySelector('.model-status').textContent).toContain('Installed');
        expect(button.disabled).toBe(true);
    });

    test('partial model data cannot be removed during permission or active download', async () => {
        partialModels.add('mediapipe-cpu');
        // Initial read-only status refresh completes before the user interacts.
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const remove = row.querySelector('.model-remove');
        const download = row.querySelector('.model-download');
        const probe = row.querySelector('.model-test');
        // Initial mount has already cached a partial model's status in this test.
        remove.disabled = false;
        let allowPermission;
        global.browser.permissions.request.mockImplementation(() =>
            new Promise(resolve => { allowPermission = resolve; }));
        let finishInstall;
        installModel.mockImplementation(() => new Promise(resolve => { finishInstall = resolve; }));
        download.click();
        expect(remove.disabled).toBe(true);
        expect(probe.disabled).toBe(true);
        remove.click();
        expect(removeModel).not.toHaveBeenCalled();
        allowPermission(true);
        await waitFor(() => installModel.mock.calls.length === 1);
        expect(remove.disabled).toBe(true);
        remove.click();
        expect(removeModel).not.toHaveBeenCalled();
        installedModels.add('cpu');
        finishInstall();
        await waitFor(() => row.querySelector('progress').value === 100);
        expect(remove.disabled).toBe(false);
    });

    test('download stays locked until its final cache-status read completes', async () => {
        global.browser.permissions.request.mockResolvedValue(true);
        let finishInstall;
        installModel.mockImplementation(() => new Promise(resolve => { finishInstall = resolve; }));
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const download = row.querySelector('.model-download');
        download.click();
        await waitFor(() => installModel.mock.calls.length === 1);
        let releaseStatus;
        delayedCpuStatus = new Promise(resolve => { releaseStatus = resolve; });
        installedModels.add('cpu');
        finishInstall();
        await waitFor(() => download.textContent.startsWith('Download '));
        expect(download.disabled).toBe(true);
        download.click();
        expect(global.browser.permissions.request).toHaveBeenCalledTimes(1);
        releaseStatus();
        await waitFor(() => row.querySelector('progress').value === 100);
        expect(download.disabled).toBe(true); // installed model
        expect(row.querySelector('.model-status').textContent).toContain('Installed');
    });

    test('ONNX inference prevents dictionary removal and other model downloads', async () => {
        const onnx = document.querySelector('[data-variant="onnx-q8"]');
        const dictionary = document.querySelector('[data-variant="dictionary-english"]');
        const mediapipe = document.querySelector('[data-variant="mediapipe-cpu"]');
        expect(dictionary.querySelector('.model-remove').disabled).toBe(false);
        expect(mediapipe.querySelector('.model-download').disabled).toBe(false);
        let finishInference;
        engine.synthesizePhonemes.mockImplementationOnce(() => new Promise(resolve => {
            finishInference = resolve;
        }));
        onnx.querySelector('.model-test').click();
        await waitFor(() => typeof finishInference === 'function');
        expect(dictionary.querySelector('.model-remove').disabled).toBe(true);
        expect(mediapipe.querySelector('.model-download').disabled).toBe(true);
        dictionary.querySelector('.model-remove').click();
        mediapipe.querySelector('.model-download').click();
        expect(removeModel).not.toHaveBeenCalled();
        expect(global.browser.permissions.request).not.toHaveBeenCalled();

        finishInference(audio());
        await waitFor(() => onnx.querySelector('.model-status').textContent
            .includes('Full-clip synthesis p50'));
        expect(dictionary.querySelector('.model-remove').disabled).toBe(false);
        expect(mediapipe.querySelector('.model-download').disabled).toBe(false);
    });

    test('download blocks concurrent ONNX inference and dictionary removal, then unlocks', async () => {
        global.browser.permissions.request.mockResolvedValue(true);
        let finishInstall;
        installModel.mockImplementation(() => new Promise(resolve => {
            finishInstall = resolve;
        }));
        const mediapipe = document.querySelector('[data-variant="mediapipe-cpu"]');
        const onnx = document.querySelector('[data-variant="onnx-q8"]');
        const dictionary = document.querySelector('[data-variant="dictionary-english"]');
        mediapipe.querySelector('.model-download').click();
        await waitFor(() => typeof finishInstall === 'function');
        expect(onnx.querySelector('.model-test').disabled).toBe(true);
        expect(dictionary.querySelector('.model-remove').disabled).toBe(true);
        onnx.querySelector('.model-test').click();
        dictionary.querySelector('.model-remove').click();
        expect(engine.initialize).not.toHaveBeenCalled();
        expect(removeModel).not.toHaveBeenCalled();
        installedModels.add('cpu');
        finishInstall();
        await waitFor(() => mediapipe.querySelector('progress').value === 100);
        expect(onnx.querySelector('.model-test').disabled).toBe(false);
        expect(dictionary.querySelector('.model-remove').disabled).toBe(false);
    });

    test('dictionary removal blocks ONNX tests even when a model variant is installed', async () => {
        const dictionary = document.querySelector('[data-variant="dictionary-english"]');
        const onnx = document.querySelector('[data-variant="onnx-q8"]');
        let finishRemoval;
        removeModel.mockImplementation(() => new Promise(resolve => {
            finishRemoval = resolve;
        }));
        dictionary.querySelector('.model-remove').click();
        await waitFor(() => typeof finishRemoval === 'function');
        expect(onnx.querySelector('.model-test').disabled).toBe(true);
        onnx.querySelector('.model-test').click();
        expect(engine.initialize).not.toHaveBeenCalled();
        dictionaryReady = false;
        finishRemoval();
        await waitFor(() => dictionary.querySelector('.model-status').textContent
            .includes('Not installed'));
        expect(onnx.querySelector('.model-test').disabled).toBe(false);
        expect(dictionary.querySelector('.model-remove').disabled).toBe(true);
    });

    test('a model removal blocks inference until cache mutation completes', async () => {
        const row = document.querySelector('[data-variant="onnx-q8"]');
        let finishRemoval;
        removeModel.mockImplementation(() => new Promise(resolve => {
            finishRemoval = resolve;
        }));
        row.querySelector('.model-remove').click();
        await waitFor(() => typeof finishRemoval === 'function');
        expect(row.querySelector('.model-test').disabled).toBe(true);
        expect(row.querySelector('.model-download').disabled).toBe(true);
        row.querySelector('.model-test').click();
        expect(engine.synthesizePhonemes).not.toHaveBeenCalled();
        finishRemoval();
        await waitFor(() => row.querySelector('.model-test').disabled === false);
        expect(removeModel).toHaveBeenCalledTimes(1);
    });

    test('denied model-host permission restores existing partial-model actions', async () => {
        partialModels.add('mediapipe-cpu');
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const remove = row.querySelector('.model-remove');
        const download = row.querySelector('.model-download');
        remove.disabled = false;
        global.browser.permissions.request.mockResolvedValue(false);
        download.click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('permission was denied'));
        expect(remove.disabled).toBe(false);
        expect(download.disabled).toBe(false);
        expect(installModel).not.toHaveBeenCalled();
    });

    test('model cannot be removed while a local inference probe is running', async () => {
        const row = document.querySelector('[data-variant="onnx-q8"]');
        const remove = row.querySelector('.model-remove');
        expect(remove.disabled).toBe(false);
        let finishProbe;
        engine.synthesizePhonemes.mockImplementationOnce(() =>
            new Promise(resolve => { finishProbe = resolve; }));
        row.querySelector('.model-test').click();
        await waitFor(() => typeof finishProbe === 'function');
        expect(remove.disabled).toBe(true);
        remove.click();
        expect(removeModel).not.toHaveBeenCalled();
        finishProbe(audio());
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Full-clip synthesis p50'));
        expect(remove.disabled).toBe(false);
    });

    test('unsupported MediaPipe GPU shows capability result without attempting inference', async () => {
        installedModels.add('gpu');
        window.KokoroBenchmark.inspectCapabilities = jest.fn(async () => ({
            webgpu: { status: 'no-adapter' },
        }));
        const row = document.querySelector('[data-variant="mediapipe-gpu"]');
        const button = row.querySelector('.model-test');
        button.disabled = false; // Model is cached in this test scenario.
        button.click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('GPU test unavailable'));
        expect(row.querySelector('.model-status').textContent).toContain('no-adapter');
        expect(row.querySelector('.model-status').textContent).toContain('No inference was attempted');
        expect(require('../mediapipe-provider.js').MediaPipeKokoroProvider).not.toHaveBeenCalled();
        expect(global.browser.storage.local.remove).toHaveBeenCalledWith('mediapipeValidatedRevision:gpu');
        expect(global.browser.storage.local.set).not.toHaveBeenCalled();
        expect(row.querySelector('.model-choose').disabled).toBe(true);
        expect(button.disabled).toBe(false);
    });

    test('MediaPipe GPU only attempts its real provider when adapter is available', async () => {
        installedModels.add('gpu');
        window.KokoroBenchmark.inspectCapabilities = jest.fn(async () => ({
            webgpu: { status: 'adapter-available' },
        }));
        require('../mediapipe-provider.js').MediaPipeKokoroProvider.mockImplementation(() => engine);
        const row = document.querySelector('[data-variant="mediapipe-gpu"]');
        const button = row.querySelector('.model-test');
        button.disabled = false;
        button.click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Full-clip synthesis p50'));
        expect(engine.initialize).toHaveBeenCalledTimes(1);
        expect(engine.synthesize).toHaveBeenCalledTimes(3);
        expect(require('../mediapipe-provider.js').MediaPipeKokoroProvider)
            .toHaveBeenCalledWith({ variant: 'gpu' });
        expect(global.browser.storage.local.set).toHaveBeenCalled();
        expect(row.querySelector('audio').hidden).toBe(false);
    });

    test('refused optional download permission hides the progress bar without fetching', async () => {
        global.browser.permissions.request.mockResolvedValue(false);
        const row = document.querySelector('[data-variant="mediapipe-gpu"]');
        const button = row.querySelector('.model-download');
        const progress = row.querySelector('progress');
        button.click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('permission was denied'));
        expect(progress.hidden).toBe(true);
        expect(installModel).not.toHaveBeenCalled();
        expect(button.disabled).toBe(false);
    });

    test('cancel hides partial progress and restores the model download action', async () => {
        global.browser.permissions.request.mockResolvedValue(true);
        installModel.mockImplementation((manifest, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(new DOMException('Download aborted', 'AbortError'));
            });
        }));
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const button = row.querySelector('.model-download');
        const progress = row.querySelector('progress');
        button.click();
        await waitFor(() => installModel.mock.calls.length === 1);
        expect(button.textContent).toBe('Cancel download');
        button.click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Download cancelled'));
        expect(progress.hidden).toBe(true);
        expect(button.textContent).toContain('Download');
        expect(button.disabled).toBe(false);
    });

    test('failed integrity/storage install does not display a completed download', async () => {
        global.browser.permissions.request.mockResolvedValue(true);
        installModel.mockRejectedValue(new Error('Integrity mismatch'));
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const progress = row.querySelector('progress');
        row.querySelector('.model-download').click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Integrity mismatch'));
        expect(progress.hidden).toBe(true);
        expect(installModel).toHaveBeenCalledTimes(1);
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
