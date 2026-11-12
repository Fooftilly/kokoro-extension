/**
 * @jest-environment jsdom
 */
import { installImmediateModelLocks } from './helpers/model-locks.js';
jest.mock('../model-data-store.js', () => ({
    ModelDataStore: jest.fn(),
    formatModelSize: bytes => (bytes / 1000000).toFixed(1) + ' MB',
    assessStorageHeadroom: jest.requireActual('../model-data-store.js').assessStorageHeadroom,
}));
jest.mock('../mediapipe-provider.js', () => ({ MediaPipeKokoroProvider: jest.fn() }));
jest.mock('../onnx-provider.js', () => ({ OnnxKokoroProvider: jest.fn() }));
jest.mock('../pcm-wav.js', () => ({ pcmToWavBlob: jest.fn(() => new Blob(['wav'])) }));

const audio = () => ({ samples: new Float32Array([0.2, -0.2]), sampleRateHz: 24000 });

describe('ONNX model manager English synthesis diagnostics', () => {
    let engine;
    let dictionaryReady;
    let installedModels;
    let installedOnnxVariants;
    let partialModels;
    let installModel;
    let removeModel;
    let verifyModel;
    let pruneModels;
    let delayedCpuStatus;
    let failStatusFor;
    beforeEach(async () => {
        jest.resetModules();
        dictionaryReady = true;
        installedModels = new Set();
        installedOnnxVariants = new Set(['q8']);
        partialModels = new Set();
        installModel = jest.fn();
        removeModel = jest.fn();
        pruneModels = jest.fn(async () => 0);
        verifyModel = jest.fn(async manifest => {
            const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
            return { ready: true, verifiedBytes: totalBytes, totalBytes,
                removedAssets: 0, missingAssets: 0 };
        });
        delayedCpuStatus = null;
        failStatusFor = new Set();
        document.body.innerHTML = `
            <button id="refreshModelCache" disabled>Recheck installed models</button>
            <button id="cleanOutdatedModels" disabled>Remove obsolete model cache files</button>
            <p id="modelRecheckStatus" role="status"></p>
            <p id="modelCleanupStatus" role="status"></p>
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
        Object.defineProperty(global.navigator, 'storage', {
            configurable: true, value: undefined,
        });
        installImmediateModelLocks();
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
                if (failStatusFor.has(manifest.provider + '-' + manifest.variant)) {
                    throw new Error('Cache status unavailable');
                }
                if (delayedCpuStatus && manifest.provider === 'mediapipe' &&
                    manifest.variant === 'cpu') await delayedCpuStatus;
                const ready = (manifest.provider === 'onnx' &&
                    installedOnnxVariants.has(manifest.variant)) ||
                    (manifest.provider === 'dictionary' && dictionaryReady) ||
                    (manifest.provider === 'mediapipe' && installedModels.has(manifest.variant));
                const totalBytes = manifest.assets.reduce((sum, a) => sum + a.bytes, 0);
                return { ready, totalBytes, storedBytes: ready ? totalBytes :
                    partialModels.has(manifest.provider + '-' + manifest.variant) ? 4 : 0 };
            }),
            install: installModel,
            remove: removeModel,
            verifyAndPruneCorrupt: verifyModel,
            removeUnreferenced: pruneModels,
        }));
        require('../model-manager-page.js');
        await new Promise(resolve => setTimeout(resolve, 0));
    });

    afterEach(() => {
        // Remove module-scoped focus/visibility listeners between jsdom tests.
        window.dispatchEvent(new Event('pagehide'));
    });

    test('obsolete cache cleanup is opt-in and preserves all pinned variants', async () => {
        const cleanup = document.getElementById('cleanOutdatedModels');
        const status = document.getElementById('modelCleanupStatus');
        const existing = document.querySelector('[data-variant="onnx-q8"]');
        const other = document.querySelector('[data-variant="mediapipe-cpu"]');
        const confirm = jest.spyOn(window, 'confirm')
            .mockReturnValueOnce(false).mockReturnValueOnce(true);
        expect(cleanup.disabled).toBe(false);
        expect(pruneModels).not.toHaveBeenCalled(); // No automatic pruning.
        cleanup.click();
        expect(pruneModels).not.toHaveBeenCalled();
        let finish;
        pruneModels.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        cleanup.click();
        await waitFor(() => pruneModels.mock.calls.length === 1);
        const retained = pruneModels.mock.calls[0][0];
        expect(retained.map(m => m.provider + '-' + m.variant).sort()).toEqual([
            'dictionary-english', 'mediapipe-cpu', 'mediapipe-gpu', 'onnx-q8', 'onnx-q8f16',
        ]);
        expect(cleanup.disabled).toBe(true);
        expect(existing.querySelector('.model-test').disabled).toBe(true);
        expect(other.querySelector('.model-download').disabled).toBe(true);
        finish(3);
        await waitFor(() => status.textContent.includes('Removed 3 obsolete cached asset(s)'));
        expect(cleanup.disabled).toBe(false);
        expect(existing.querySelector('.model-test').disabled).toBe(false);
        expect(other.querySelector('.model-download').disabled).toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(global.browser.permissions.request).not.toHaveBeenCalled();
        confirm.mockRestore();
    });

    test('obsolete cache cleanup failures restore model controls without deleting current data', async () => {
        const confirm = jest.spyOn(window, 'confirm').mockReturnValueOnce(true);
        pruneModels.mockRejectedValueOnce(new Error('Cache unavailable'));
        document.getElementById('cleanOutdatedModels').click();
        await waitFor(() => document.getElementById('modelCleanupStatus').textContent
            .includes('Cache unavailable'));
        expect(document.querySelector('[data-variant="onnx-q8"] .model-test').disabled)
            .toBe(false);
        expect(document.querySelector('[data-variant="mediapipe-cpu"] .model-download').disabled)
            .toBe(false);
        expect(document.getElementById('cleanOutdatedModels').disabled).toBe(false);
        confirm.mockRestore();
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

    test('explicit SHA-256 verification checks installed bytes without requesting download permissions', async () => {
        const row = document.querySelector('[data-variant="onnx-q8"]');
        const button = row.querySelector('.model-verify');
        // A quick cache-status read must not claim the stored bytes were rehashed.
        expect(row.querySelector('.model-status').textContent)
            .toContain('Use Verify cached data to recheck SHA-256 integrity');
        expect(verifyModel).not.toHaveBeenCalled();
        expect(button.disabled).toBe(false);
        expect(document.querySelector('[data-variant="mediapipe-cpu"] .model-verify').disabled)
            .toBe(true); // No recognized cached model data.
        button.click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('pinned SHA-256 hashes'));
        expect(verifyModel).toHaveBeenCalledTimes(1);
        expect(verifyModel.mock.calls[0][0].provider).toBe('onnx');
        expect(button.disabled).toBe(false);
        expect(row.querySelector('.model-test').disabled).toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(global.browser.permissions.request).not.toHaveBeenCalled();
        expect(installModel).not.toHaveBeenCalled();
    });

    test('a failed verifier leaves installed models available without deleting or downloading', async () => {
        verifyModel.mockRejectedValue(new Error('Crypto not available'));
        const row = document.querySelector('[data-variant="onnx-q8"]');
        row.querySelector('.model-verify').click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Crypto not available'));
        expect(row.querySelector('.model-test').disabled).toBe(false);
        expect(row.querySelector('.model-remove').disabled).toBe(false);
        expect(removeModel).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('corrupt cached MediaPipe data is evicted, validation revoked and repair requires opt-in', async () => {
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const recheck = document.getElementById('refreshModelCache');
        installedModels.add('cpu');
        recheck.click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Installed'));
        row.querySelector('.model-choose').disabled = false; // Previously validated by a real test.
        verifyModel.mockImplementation(async (manifest, options) => {
            installedModels.delete('cpu');
            options.onProgress({
                verifiedBytes: 0, totalBytes: manifest.assets[0].bytes,
                removedAssets: 1, missingAssets: 0,
            });
            return { ready: false, verifiedBytes: 0, totalBytes: manifest.assets[0].bytes,
                removedAssets: 1, missingAssets: 0 };
        });
        row.querySelector('.model-verify').click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Click Download'));
        expect(row.querySelector('.model-choose').disabled).toBe(true);
        expect(row.querySelector('.model-test').disabled).toBe(true);
        expect(row.querySelector('.model-download').disabled).toBe(false);
        expect(row.querySelector('.model-verify').disabled).toBe(true);
        expect(global.browser.storage.local.remove)
            .toHaveBeenCalledWith('mediapipeValidatedRevision:cpu');
        expect(global.browser.permissions.request).not.toHaveBeenCalled();
        expect(installModel).not.toHaveBeenCalled();
    });

    test('verification holds other download/test controls and re-enables them on completion', async () => {
        let resolveVerification;
        verifyModel.mockImplementation(() => new Promise(resolve => {
            resolveVerification = resolve;
        }));
        const row = document.querySelector('[data-variant="onnx-q8"]');
        const other = document.querySelector('[data-variant="mediapipe-cpu"]');
        row.querySelector('.model-verify').click();
        expect(other.querySelector('.model-download').disabled).toBe(true);
        expect(row.querySelector('.model-test').disabled).toBe(true);
        other.querySelector('.model-download').click();
        expect(global.browser.permissions.request).not.toHaveBeenCalled();
        const totalBytes = 92361116 + 524288;
        resolveVerification({ ready: true, verifiedBytes: totalBytes, totalBytes,
            removedAssets: 0, missingAssets: 0 });
        await waitFor(() => row.querySelector('.model-status').textContent
            .includes('pinned SHA-256 hashes'));
        expect(other.querySelector('.model-download').disabled).toBe(false);
        expect(row.querySelector('.model-test').disabled).toBe(false);
    });

    test('Cancel verification aborts SHA-256 without fetching or deleting installed data', async () => {
        const row = document.querySelector('[data-variant="onnx-q8"]');
        const button = row.querySelector('.model-verify');
        const other = document.querySelector('[data-variant="mediapipe-cpu"]');
        verifyModel.mockImplementation((manifest, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () =>
                reject(new DOMException('Verification cancelled', 'AbortError')), { once: true });
        }));
        button.click();
        await waitFor(() => verifyModel.mock.calls.length === 1);
        expect(button.textContent).toBe('Cancel verification');
        expect(button.disabled).toBe(false);
        expect(other.querySelector('.model-download').disabled).toBe(true);
        const signal = verifyModel.mock.calls[0][1].signal;
        button.click();
        expect(signal.aborted).toBe(true);
        expect(button.disabled).toBe(true);
        await waitFor(() => row.querySelector('.model-status').textContent
            .includes('Cache verification cancelled'));
        expect(button.textContent).toBe('Verify cached data');
        expect(button.disabled).toBe(false);
        expect(row.querySelector('.model-test').disabled).toBe(false);
        expect(row.querySelector('.model-remove').disabled).toBe(false);
        expect(other.querySelector('.model-download').disabled).toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(installModel).not.toHaveBeenCalled();
        expect(removeModel).not.toHaveBeenCalled();
        expect(global.browser.permissions.request).not.toHaveBeenCalled();
    });

    test('Cancel after detected MediaPipe corruption still invalidates runtime', async () => {
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        installedModels.add('cpu');
        document.getElementById('refreshModelCache').click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Installed'));
        row.querySelector('.model-choose').disabled = false;
        verifyModel.mockImplementation((manifest, { signal, onProgress }) =>
            new Promise((resolve, reject) => {
                installedModels.delete('cpu');
                onProgress({ verifiedBytes: 0, totalBytes: manifest.assets[0].bytes,
                    removedAssets: 1, missingAssets: 0 });
                signal.addEventListener('abort', () =>
                    reject(new DOMException('Verification cancelled', 'AbortError')),
                { once: true });
            }));
        const button = row.querySelector('.model-verify');
        button.click();
        await waitFor(() => button.textContent === 'Cancel verification');
        button.click();
        await waitFor(() => row.querySelector('.model-status').textContent
            .includes('Cache verification cancelled'));
        expect(global.browser.storage.local.remove)
            .toHaveBeenCalledWith('mediapipeValidatedRevision:cpu');
        expect(row.querySelector('.model-test').disabled).toBe(true);
        expect(row.querySelector('.model-choose').disabled).toBe(true);
        expect(row.querySelector('.model-download').disabled).toBe(false);
        expect(installModel).not.toHaveBeenCalled();
    });

    test('pagehide aborts active cache SHA-256 verification', async () => {
        const row = document.querySelector('[data-variant="onnx-q8"]');
        verifyModel.mockImplementation((manifest, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () =>
                reject(new DOMException('Verification cancelled', 'AbortError')), { once: true });
        }));
        row.querySelector('.model-verify').click();
        await waitFor(() => verifyModel.mock.calls.length === 1);
        const signal = verifyModel.mock.calls[0][1].signal;
        expect(signal.aborted).toBe(false);
        window.dispatchEvent(new Event('pagehide'));
        expect(signal.aborted).toBe(true);
        await waitFor(() => row.querySelector('.model-status').textContent
            .includes('Cache verification cancelled'));
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('dictionary verification removes stale in-memory ONNX lexicons after corruption', async () => {
        const { row: onnx } = await runProbe();
        expect(onnx.querySelector('.model-test').disabled).toBe(false);
        verifyModel.mockImplementation(async (manifest, options) => {
            dictionaryReady = false;
            options.onProgress({ verifiedBytes: 0, totalBytes: 3618488,
                removedAssets: 1, missingAssets: 0 });
            return { ready: false, verifiedBytes: 0, totalBytes: 3618488,
                removedAssets: 1, missingAssets: 0 };
        });
        const dictionary = document.querySelector('[data-variant="dictionary-english"]');
        dictionary.querySelector('.model-verify').click();
        await waitFor(() => dictionary.querySelector('.model-status').textContent.includes('Click Download'));
        expect(engine.close).toHaveBeenCalledTimes(1);
        expect(dictionary.querySelector('.model-download').disabled).toBe(false);
        expect(dictionary.querySelector('.model-verify').disabled).toBe(true);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('read-only recheck detects evicted models when the test page regains focus', async () => {
        const recheck = document.getElementById('refreshModelCache');
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        expect(recheck.disabled).toBe(false);
        installedModels.add('cpu');
        recheck.click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Installed'));
        expect(row.querySelector('.model-download').disabled).toBe(true);
        // Simulate a variant that was previously validated for the chooser.
        row.querySelector('.model-choose').disabled = false;
        installedModels.delete('cpu');
        window.dispatchEvent(new Event('focus'));
        await waitFor(() => row.querySelector('.model-status').textContent.includes('missing'));
        expect(row.querySelector('.model-download').disabled).toBe(false);
        expect(row.querySelector('.model-test').disabled).toBe(true);
        expect(row.querySelector('.model-remove').disabled).toBe(true);
        expect(row.querySelector('.model-choose').disabled).toBe(true);
        expect(document.getElementById('modelRecheckStatus').textContent)
            .toContain('previously installed model(s) lost data');
        expect(global.fetch).not.toHaveBeenCalled();
        expect(global.browser.permissions.request).not.toHaveBeenCalled();
        expect(installModel).not.toHaveBeenCalled();
        expect(navigator.locks.request).toHaveBeenCalledWith(
            'kokoro-model-data-v1', { mode: 'shared' }, expect.any(Function));
    });

    test('recheck on visibility restoration detects newly available cache without auto-testing', async () => {
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const recheck = document.getElementById('refreshModelCache');
        expect(row.querySelector('.model-download').disabled).toBe(false);
        installedModels.add('cpu');
        Object.defineProperty(document, 'visibilityState', {
            configurable: true, value: 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Installed'));
        expect(row.querySelector('.model-download').disabled).toBe(true);
        expect(row.querySelector('.model-test').disabled).toBe(false);
        expect(row.querySelector('.model-choose').disabled).toBe(true);
        expect(recheck.disabled).toBe(false);
        expect(engine.initialize).not.toHaveBeenCalled();
        expect(global.browser.permissions.request).not.toHaveBeenCalled();
    });

    test('unchanged cache check preserves the previous benchmark diagnostics', async () => {
        const { row, message } = await runProbe();
        const button = document.getElementById('refreshModelCache');
        button.click();
        await waitFor(() => document.getElementById('modelRecheckStatus').textContent
            .includes('all model statuses unchanged'));
        expect(row.querySelector('.model-status').textContent).toBe(message);
        expect(row.querySelector('.model-test').disabled).toBe(false);
        expect(button.disabled).toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('failed recheck preserves existing controls and permits retry', async () => {
        const row = document.querySelector('[data-variant="onnx-q8"]');
        expect(row.querySelector('.model-test').disabled).toBe(false);
        failStatusFor.add('mediapipe-cpu');
        const button = document.getElementById('refreshModelCache');
        button.click();
        await waitFor(() => document.getElementById('modelRecheckStatus').textContent
            .includes('Cannot recheck model cache'));
        expect(row.querySelector('.model-test').disabled).toBe(false);
        expect(button.disabled).toBe(false);
        failStatusFor.clear();
        button.click();
        await waitFor(() => document.getElementById('modelRecheckStatus').textContent
            .includes('all model statuses unchanged'));
    });

    test('stale cache recheck never overwrites an in-progress model permission request', async () => {
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const recheck = document.getElementById('refreshModelCache');
        let releaseStatus;
        delayedCpuStatus = new Promise(resolve => { releaseStatus = resolve; });
        recheck.click();
        await waitFor(() => recheck.disabled);
        let allowPermission;
        global.browser.permissions.request.mockImplementation(() => new Promise(resolve => {
            allowPermission = resolve;
        }));
        row.querySelector('.model-download').click();
        expect(recheck.disabled).toBe(true);
        expect(row.querySelector('.model-status').textContent).toContain('permission');
        releaseStatus();
        await Promise.resolve();
        await Promise.resolve();
        expect(row.querySelector('.model-status').textContent).toContain('permission');
        expect(installModel).not.toHaveBeenCalled();
        await waitFor(() => document.getElementById('modelRecheckStatus').textContent
            .includes('superseded by a model operation'));
        expect(document.getElementById('modelRecheckStatus').textContent)
            .not.toContain('Rechecking installed model data');
        allowPermission(false);
        await waitFor(() => row.querySelector('.model-status').textContent.includes('denied'));
        expect(recheck.disabled).toBe(false);
    });

    test('discloses pinned model source, license and total cache data before any download', () => {
        const cases = [
            ['mediapipe-cpu', 'litert-community/Kokoro-82M', '294.8 MB'],
            ['mediapipe-gpu', 'litert-community/Kokoro-82M', '294.8 MB'],
            ['onnx-q8', 'onnx-community/Kokoro-82M-v1.0-ONNX', '92.9 MB'],
            ['onnx-q8f16', 'onnx-community/Kokoro-82M-v1.0-ONNX', '86.6 MB'],
            ['dictionary-english', 'cmusphinx/cmudict', '3.6 MB'],
        ];
        for (const [key, source, expectedSize] of cases) {
            const row = document.querySelector('[data-variant="' + key + '"]');
            const info = row.querySelector('.model-provenance');
            const links = info.querySelectorAll('a');
            expect(links).toHaveLength(2);
            expect(links[0].textContent).toBe(source);
            expect(links[0].href).toContain(key === 'dictionary-english'
                ? 'github.com/cmusphinx/cmudict/tree/'
                : 'huggingface.co/' + source + '/tree/');
            expect(links[1].textContent).toBe(key === 'dictionary-english'
                ? 'CMUdict permissive license' : 'Apache-2.0');
            expect(links[1].href).toContain(key === 'dictionary-english'
                ? 'github.com/cmusphinx/cmudict/blob/'
                : 'huggingface.co/' + source + '/blob/');
            expect(links[1].href).toMatch(/\/(LICENSE|README\.md)$/);
            expect(links[0].target).toBe('_blank');
            expect(links[0].rel).toBe('noopener noreferrer');
            expect(info.textContent).toContain(expectedSize);
            expect(info.textContent).toContain('browser storage overhead');
        }
        expect(global.fetch).not.toHaveBeenCalled();
        expect(global.browser.permissions.request).not.toHaveBeenCalled();
    });

    test('verified ONNX q8 English text enables explicit selection while IPA timings stay separate', async () => {
        const { row, message } = await runProbe();
        expect(engine.synthesizePhonemes).not.toHaveBeenCalled();
        expect(engine.synthesize).toHaveBeenCalledTimes(3);
        expect(engine.synthesize).toHaveBeenCalledWith('Hello world.');
        expect(message).toContain('warm (3 runs, shared English text)');
        expect(message).toContain('Measured the shared English text through the dictionary-backed ONNX path');
        expect(message).not.toContain('IPA-only diagnostic');
        expect(window.KokoroBenchmark.summarizeRuns).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({
                kind: 'warm', firstAudioMs: null,
            })]));
        expect(message).toContain('Unknown English words are not supported');
        expect(row.querySelector('audio').hidden).toBe(false);
        await waitFor(() => row.querySelector('.model-choose').disabled === false);
        expect(browser.storage.local.set).toHaveBeenCalledWith({
            'onnxValidatedRevision:q8': expect.any(String),
        });
        row.querySelector('.model-choose').click();
        await waitFor(() => browser.storage.sync.set.mock.calls
            .some(([value]) => value.ttsBackend === 'onnx'));
        expect(row.querySelector('.model-status').textContent).toContain('dictionary-supported English reading');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('missing dictionary is never downloaded implicitly and IPA remains testable', async () => {
        dictionaryReady = false;
        const { message } = await runProbe();
        expect(engine.synthesizePhonemes).toHaveBeenCalledTimes(3);
        expect(engine.synthesize).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(global.browser.permissions.request).not.toHaveBeenCalled();
        expect(message).toContain('download the pronunciation dictionary first');
        expect(message).toContain('IPA-only diagnostic');
        expect(message).toContain('not comparable with English-text timings');
        expect(document.querySelector('[data-variant="onnx-q8"] .model-choose').disabled).toBe(true);
        expect(browser.storage.local.set).not.toHaveBeenCalledWith({
            'onnxValidatedRevision:q8': expect.any(String),
        });
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

    test('unlocking other rows preserves previous ONNX synthesis diagnostics', async () => {
        const { row, message } = await runProbe();
        expect(message).toContain('Full-clip synthesis p50');
        expect(message).toContain('Measured the shared English text through the dictionary-backed ONNX path');
        global.browser.permissions.request.mockResolvedValue(false);
        const other = document.querySelector('[data-variant="mediapipe-cpu"]');
        other.querySelector('.model-download').click();
        await waitFor(() => other.querySelector('.model-status').textContent
            .includes('permission was denied'));
        expect(row.querySelector('.model-status').textContent).toBe(message);
        expect(row.querySelector('.model-test').disabled).toBe(false);
    });

    test('a failed status check after removal never revives stale installed controls', async () => {
        const row = document.querySelector('[data-variant="onnx-q8"]');
        expect(row.querySelector('.model-test').disabled).toBe(false);
        failStatusFor.add('onnx-q8');
        row.querySelector('.model-remove').click();
        await waitFor(() => row.querySelector('.model-status').textContent
            .includes('Cannot inspect model cache after removal'));
        expect(removeModel).toHaveBeenCalledTimes(1);
        expect(row.querySelector('.model-status').textContent)
            .toContain('Cache status unavailable');
        expect(row.querySelector('.model-download').disabled).toBe(false);
        expect(row.querySelector('.model-test').disabled).toBe(true);
        expect(row.querySelector('.model-remove').disabled).toBe(true);
        expect(row.querySelector('.model-choose').disabled).toBe(true);
        expect(row.querySelector('.model-status').textContent).not.toContain('Installed');
        expect(engine.synthesizePhonemes).not.toHaveBeenCalled();
    });

    test('ONNX inference prevents dictionary removal and other model downloads', async () => {
        const onnx = document.querySelector('[data-variant="onnx-q8"]');
        const dictionary = document.querySelector('[data-variant="dictionary-english"]');
        const mediapipe = document.querySelector('[data-variant="mediapipe-cpu"]');
        expect(dictionary.querySelector('.model-remove').disabled).toBe(false);
        expect(mediapipe.querySelector('.model-download').disabled).toBe(false);
        let finishInference;
        engine.synthesize.mockImplementationOnce(() => new Promise(resolve => {
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

    test('denied download permission releases every model row without writing cache', async () => {
        let resolvePermission;
        global.browser.permissions.request.mockImplementation(() => new Promise(resolve => {
            resolvePermission = resolve;
        }));
        const media = document.querySelector('[data-variant="mediapipe-cpu"]');
        const onnx = document.querySelector('[data-variant="onnx-q8"]');
        const dictionary = document.querySelector('[data-variant="dictionary-english"]');
        media.querySelector('.model-download').click();
        expect(typeof resolvePermission).toBe('function');
        expect(onnx.querySelector('.model-test').disabled).toBe(true);
        expect(dictionary.querySelector('.model-remove').disabled).toBe(true);
        resolvePermission(false);
        await waitFor(() => media.querySelector('.model-status').textContent
            .includes('permission was denied'));
        expect(onnx.querySelector('.model-test').disabled).toBe(false);
        expect(dictionary.querySelector('.model-remove').disabled).toBe(false);
        expect(media.querySelector('.model-download').disabled).toBe(false);
        expect(installModel).not.toHaveBeenCalled();
        expect(removeModel).not.toHaveBeenCalled();
    });

    test.each([
        ['synchronous exception', () => { throw new Error('Permission API inaccessible'); },
            'Cannot request model download permission'],
        ['rejected promise', () => Promise.reject(new Error('Permission request rejected')),
            'Model download permission failed'],
    ])('permission-request %s restores controls and permits explicit retry',
        async (_failure, failingRequest, expectedStatus) => {
            const row = document.querySelector('[data-variant="mediapipe-cpu"]');
            const other = document.querySelector('[data-variant="onnx-q8"]');
            const download = row.querySelector('.model-download');
            const progress = row.querySelector('.model-download-progress');
            global.browser.permissions.request.mockImplementationOnce(failingRequest)
                .mockResolvedValueOnce(true);
            download.click();
            await waitFor(() => row.querySelector('.model-status').textContent
                .includes(expectedStatus));
            expect(download.disabled).toBe(false);
            expect(progress.hidden).toBe(true);
            expect(other.querySelector('.model-test').disabled).toBe(false);
            expect(installModel).not.toHaveBeenCalled();
            expect(global.fetch).not.toHaveBeenCalled();
            expect(global.browser.permissions.request).toHaveBeenCalledTimes(1);
            // No implicit permission retry or download after an error.
            await Promise.resolve();
            expect(global.browser.permissions.request).toHaveBeenCalledTimes(1);
            installModel.mockImplementationOnce(async () => {
                installedModels.add('cpu');
            });
            download.click();
            await waitFor(() => row.querySelector('.model-status').textContent
                .includes('Installed'));
            expect(global.browser.permissions.request).toHaveBeenCalledTimes(2);
            expect(installModel).toHaveBeenCalledTimes(1);
            expect(download.disabled).toBe(true);
            expect(global.fetch).not.toHaveBeenCalled();
        });

    test('interrupted partial model install does not self-retry and preserves manual recovery', async () => {
        partialModels.add('mediapipe-cpu'); // Represents an intact earlier asset.
        global.browser.permissions.request.mockResolvedValue(true);
        installModel.mockRejectedValueOnce(new Error('Simulated interrupted transfer'));
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const download = row.querySelector('.model-download');
        const progress = row.querySelector('.model-download-progress');
        download.click();
        await waitFor(() => row.querySelector('.model-status').textContent
            .includes('Simulated interrupted transfer'));
        expect(progress.hidden).toBe(true);
        expect(download.disabled).toBe(false);
        expect(row.querySelector('.model-remove').disabled).toBe(false);
        expect(installModel).toHaveBeenCalledTimes(1);
        expect(global.browser.permissions.request).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        expect(installModel).toHaveBeenCalledTimes(1);
        installModel.mockImplementationOnce(async () => {
            installedModels.add('cpu');
            partialModels.delete('mediapipe-cpu');
        });
        download.click(); // Only a second explicit gesture may retry.
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Installed'));
        expect(installModel).toHaveBeenCalledTimes(2);
        expect(global.browser.permissions.request).toHaveBeenCalledTimes(2);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('local benchmark takes a shared lease through inference and diagnostics', async () => {
        const { message } = await runProbe();
        expect(message).toContain('Full-clip synthesis p50');
        expect(navigator.locks.request).toHaveBeenCalledWith(
            'kokoro-model-data-v1', { mode: 'shared' }, expect.any(Function));
        expect(engine.synthesize).toHaveBeenCalledTimes(3);
        expect(engine.synthesizePhonemes).not.toHaveBeenCalled();
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
        engine.synthesize.mockImplementationOnce(() =>
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

    test('warns while a low-quota download is active, then clears after successful install', async () => {
        global.browser.permissions.request.mockResolvedValue(true);
        let finishInstall;
        installModel.mockImplementation(() => new Promise(resolve => { finishInstall = resolve; }));
        Object.defineProperty(global.navigator, 'storage', {
            configurable: true,
            value: { estimate: jest.fn(async () => ({
                quota: 300000000, usage: 290000000,
            })) },
        });
        partialModels.add('mediapipe-cpu');
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const warning = row.querySelector('.model-storage-warning');
        expect(warning.hidden).toBe(true);
        expect(navigator.storage.estimate).not.toHaveBeenCalled();
        row.querySelector('.model-download').click();
        await waitFor(() => installModel.mock.calls.length === 1);
        expect(warning.hidden).toBe(false);
        expect(warning.getAttribute('role')).toBe('alert');
        expect(warning.textContent).toContain('10.0 MB available');
        expect(warning.textContent).toContain('294.8 MB');
        expect(warning.textContent).toContain('may fail');
        expect(global.browser.permissions.request).toHaveBeenCalledTimes(1);
        expect(global.fetch).not.toHaveBeenCalled();
        installedModels.add('cpu');
        finishInstall();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Installed'));
        expect(warning.hidden).toBe(true);
        expect(warning.textContent).toBe('');
    });

    test('cancel while waiting for a storage estimate never starts the model install', async () => {
        global.browser.permissions.request.mockResolvedValue(true);
        let finishEstimate;
        Object.defineProperty(global.navigator, 'storage', {
            configurable: true,
            value: { estimate: jest.fn(() => new Promise(resolve => {
                finishEstimate = resolve;
            })) },
        });
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const download = row.querySelector('.model-download');
        download.click();
        await waitFor(() => typeof finishEstimate === 'function');
        expect(download.textContent).toBe('Cancel download');
        download.click();
        finishEstimate({ quota: 300000000, usage: 290000000 });
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Download cancelled'));
        expect(installModel).not.toHaveBeenCalled();
        expect(row.querySelector('.model-storage-warning').hidden).toBe(true);
        expect(row.querySelector('.model-storage-warning').textContent).toBe('');
    });

    test('clears a low-space warning when an active download is cancelled', async () => {
        global.browser.permissions.request.mockResolvedValue(true);
        Object.defineProperty(global.navigator, 'storage', {
            configurable: true,
            value: { estimate: jest.fn(async () => ({ quota: 300000000, usage: 290000000 })) },
        });
        installModel.mockImplementation((manifest, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () =>
                reject(new DOMException('Download aborted', 'AbortError')), { once: true });
        }));
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const download = row.querySelector('.model-download');
        const warning = row.querySelector('.model-storage-warning');
        download.click();
        await waitFor(() => installModel.mock.calls.length === 1);
        expect(warning.hidden).toBe(false);
        download.click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Download cancelled'));
        expect(warning.hidden).toBe(true);
        expect(warning.textContent).toBe('');
    });

    test('clears a low-space warning when model installation fails', async () => {
        global.browser.permissions.request.mockResolvedValue(true);
        Object.defineProperty(global.navigator, 'storage', {
            configurable: true,
            value: { estimate: jest.fn(async () => ({ quota: 300000000, usage: 290000000 })) },
        });
        let rejectInstall;
        installModel.mockImplementation(() => new Promise((resolve, reject) => {
            rejectInstall = reject;
        }));
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        const warning = row.querySelector('.model-storage-warning');
        row.querySelector('.model-download').click();
        await waitFor(() => typeof rejectInstall === 'function');
        expect(warning.hidden).toBe(false);
        rejectInstall(new Error('Cache quota exceeded'));
        await waitFor(() => row.querySelector('.model-status').textContent.includes('Cache quota exceeded'));
        expect(warning.hidden).toBe(true);
        expect(warning.textContent).toBe('');
    });

    test('failed storage estimate is advisory and does not prevent explicit installation', async () => {
        global.browser.permissions.request.mockResolvedValue(true);
        Object.defineProperty(global.navigator, 'storage', {
            configurable: true,
            value: { estimate: jest.fn(async () => { throw new Error('Storage estimate blocked'); }) },
        });
        const row = document.querySelector('[data-variant="mediapipe-cpu"]');
        row.querySelector('.model-download').click();
        await waitFor(() => installModel.mock.calls.length === 1);
        expect(row.querySelector('.model-storage-warning').hidden).toBe(true);
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

    test('partial ONNX English synthesis never mixes its timings into the IPA fallback', async () => {
        engine.synthesize
            .mockResolvedValueOnce(audio())
            .mockRejectedValueOnce(new Error('Unsupported sentence'));
        const { row, message } = await runProbe();
        expect(message).toContain('English text synthesis failed: Unsupported sentence');
        expect(message).toContain('IPA-only diagnostic');
        expect(engine.synthesize).toHaveBeenCalledTimes(2);
        expect(engine.synthesizePhonemes).toHaveBeenCalledTimes(3);
        expect(window.KokoroBenchmark.summarizeRuns).toHaveBeenCalledTimes(1);
        expect(window.KokoroBenchmark.summarizeRuns.mock.calls[0][0]).toHaveLength(3);
        expect(row.querySelector('.model-choose').disabled).toBe(true);
        expect(browser.storage.local.set).not.toHaveBeenCalledWith({
            'onnxValidatedRevision:q8': expect.any(String),
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('q8f16 stays IPA-only and cannot authorize ordinary English reading', async () => {
        installedOnnxVariants.add('q8f16');
        const row = document.querySelector('[data-variant="onnx-q8f16"]');
        row.querySelector('.model-test').disabled = false;
        row.querySelector('.model-test').click();
        await waitFor(() => row.querySelector('.model-status').textContent.includes(
            'Streaming time-to-first-audio was not measured'));
        expect(row.querySelector('.model-status').textContent)
            .toContain('IPA-only diagnostic');
        expect(row.querySelector('.model-status').textContent)
            .toContain('This ONNX variant is IPA-only');
        expect(engine.synthesizePhonemes).toHaveBeenCalledTimes(3);
        expect(engine.synthesize).not.toHaveBeenCalled();
        expect(row.querySelector('.model-choose').disabled).toBe(true);
        expect(browser.storage.local.set).not.toHaveBeenCalledWith({
            'onnxValidatedRevision:q8': expect.any(String),
        });
    });

    test('an English G2P error leaves the valid IPA audio available', async () => {
        engine.synthesize.mockRejectedValueOnce(new Error('Unknown English word'));
        const { row, message } = await runProbe();
        expect(message).toContain('English text synthesis failed: Unknown English word');
        expect(message).toContain('Playing the IPA probe instead');
        expect(message).toContain('warm (3 runs, IPA-only diagnostic)');
        expect(engine.synthesizePhonemes).toHaveBeenCalledTimes(3);
        expect(engine.synthesize).toHaveBeenCalledTimes(1);
        expect(window.KokoroBenchmark.summarizeRuns).toHaveBeenCalledTimes(1);
        expect(window.KokoroBenchmark.summarizeRuns.mock.calls[0][0]).toHaveLength(3);
        expect(row.querySelector('audio').src).toBe('blob:test-audio');
        expect(row.querySelector('.model-choose').disabled).toBe(true);
        expect(browser.storage.local.set).not.toHaveBeenCalledWith({
            'onnxValidatedRevision:q8': expect.any(String),
        });
        expect(browser.storage.local.remove).toHaveBeenCalledWith('onnxValidatedRevision:q8');
    });
});
