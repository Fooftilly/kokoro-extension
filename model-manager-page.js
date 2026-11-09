// Extension-owned local model manager and *real* opt-in test harness.
// No model fetch occurs when this page loads, and local test inputs stay here.
import { listModelVariants, manifestForVariant, dictionaryManifest } from './model-catalog.js';
import { ModelDataStore, formatModelSize, assessStorageHeadroom } from './model-data-store.js';
import { withModelDataLock } from './model-data-lock.js';
import { MediaPipeKokoroProvider } from './mediapipe-provider.js';
import { OnnxKokoroProvider } from './onnx-provider.js';
import { pcmToWavBlob } from './pcm-wav.js';

const page = document.getElementById('modelManager');
const dictionary = dictionaryManifest();
const variants = [...listModelVariants(), {
    key: 'dictionary-english', provider: 'dictionary', variant: 'english',
    label: 'English pronunciation dictionary (optional offline download)',
    totalBytes: dictionary.assets.reduce((sum, asset) => sum + asset.bytes, 0),
}];

function entryManifest(entry) {
    return entry.provider === 'dictionary'
        ? dictionaryManifest() : manifestForVariant(entry.provider, entry.variant);
}
const engineByKey = new Map();
const inFlightDownloads = new Map();
const lastAudioUrl = new Map();
const modelRows = new Map();
let activeModelOperation = null; // one mutating/inference operation per manager page

function beginModelOperation(entry, ui, kind) {
    if (activeModelOperation || ui.busy) return false;
    const prior = new Map();
    activeModelOperation = { key: entry.key, prior };
    ui.busy = kind;
    // ONNX variants share a downloadable pronunciation dictionary. Removing
    // another row's assets while its engine is testing can corrupt inference.
    // Also avoid competing large writes and tests within this manager page.
    for (const [key, other] of modelRows) {
        if (key === entry.key) continue;
        prior.set(key, {
            download: other.download.disabled, remove: other.remove.disabled,
            test: other.test.disabled, choose: other.choose.disabled,
        });
        other.download.disabled = true;
        other.remove.disabled = true;
        other.test.disabled = true;
        other.choose.disabled = true;
    }
    return true;
}

function finishModelOperation(entry, ui) {
    const operation = activeModelOperation;
    ui.busy = null;
    activeModelOperation = null;
    for (const [key, previous] of operation?.prior || []) {
        const other = modelRows.get(key);
        if (!other) continue;
        // Initial cache reads may have settled while another row was locked.
        // Prefer their latest status, while retaining previously validated
        // MediaPipe selection when the cached model is still installed.
        if (other.lastStatus) {
            const mayChoose = previous.choose === false && other.lastStatus.ready;
            applyModelStatus(other.entry, other, other.lastStatus, { updateMessage: false });
            if (mayChoose) other.choose.disabled = false;
        } else {
            for (const [name, disabled] of Object.entries(previous)) {
                other[name].disabled = disabled;
            }
        }
    }
}

function cacheStore() {
    return new ModelDataStore({
        origin: browser.runtime.getURL('/'), cacheStorage: caches,
        fetchImpl: fetch.bind(globalThis),
        responseClass: Response, streamClass: TransformStream,
    });
}

function setMessage(node, message) {
    node.textContent = message;
}

function displayModelStatus(entry, ready, totalBytes) {
    if (ready) return 'Installed (' + formatModelSize(totalBytes) + ' verified model data)';
    return 'Not installed — ' + formatModelSize(entry.totalBytes) + ' opt-in download';
}

function createModelRow(entry) {
    const row = document.createElement('article');
    row.className = 'model-variant';
    row.dataset.variant = entry.key;
    const title = document.createElement('h3');
    title.textContent = entry.label;
    const status = document.createElement('p');
    status.className = 'model-status';
    status.setAttribute('role', 'status');
    const storageWarning = document.createElement('p');
    storageWarning.className = 'model-storage-warning';
    storageWarning.setAttribute('role', 'alert');
    storageWarning.hidden = true;
    const progress = document.createElement('progress');
    progress.className = 'model-download-progress';
    progress.max = 100;
    progress.hidden = true;
    progress.setAttribute('aria-label', entry.label + ' download progress');
    const actions = document.createElement('div');
    actions.className = 'model-actions';
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = 'Download ' + formatModelSize(entry.totalBytes);
    download.className = 'model-download';
    download.disabled = true; // Disabled until the initial cache status resolves.
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.className = 'model-remove';
    remove.disabled = true;
    const test = document.createElement('button');
    test.type = 'button';
    test.textContent = 'Test synthesized audio (3 runs)';
    test.className = 'model-test';
    test.disabled = true;
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.textContent = 'Use this backend';
    choose.className = 'model-choose';
    choose.disabled = true;
    if (entry.provider === 'dictionary') {
        test.hidden = true;
        choose.hidden = true;
        test.disabled = true;
    }
    actions.append(download, remove, test, choose);
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.hidden = true;
    row.append(title, status, storageWarning, progress, actions, audio);
    return { row, status, storageWarning, progress, download, remove, test, choose, audio, busy: null };
}

function applyModelStatus(entry, ui, state, { updateMessage = true } = {}) {
    ui.lastStatus = state;
    // Refreshing unrelated controls must not erase benchmark results or an
    // inference failure that still describes the current model.
    if (updateMessage && !ui.busy) {
        setMessage(ui.status, displayModelStatus(entry, state.ready, state.totalBytes));
    }
    // A delayed cache-status response must not re-enable controls while
    // any model or dependency is being downloaded, removed, or used in a test.
    const blocked = !!ui.busy ||
        !!(activeModelOperation && activeModelOperation.key !== entry.key);
    ui.test.disabled = blocked || entry.provider === 'dictionary' || !state.ready;
    ui.remove.disabled = blocked || !state.storedBytes;
    ui.download.disabled = ui.busy === 'download' ? false : blocked || state.ready;
    if (blocked || !state.ready) ui.choose.disabled = true;
}

async function refresh(entry, ui) {
    const state = await cacheStore().status(entryManifest(entry));
    applyModelStatus(entry, ui, state);
    return state;
}

// Advisory only: quota estimates may be unavailable or change at any time.
// Preserve the original download's abort signal through the optional check.
async function warnStorageHeadroom(manifest, ui, signal) {
    const storage = globalThis.navigator?.storage;
    if (typeof storage?.estimate === 'function') {
        try {
            const [cacheState, estimate] = await Promise.all([
                cacheStore().status(manifest), storage.estimate(),
            ]);
            const remaining = Math.max(0, cacheState.totalBytes - cacheState.storedBytes);
            const headroom = assessStorageHeadroom(remaining, estimate);
            // The estimate can finish after Cancel. Never display a warning
            // for a request that will not be installed.
            if (!signal.aborted && headroom?.insufficient) {
                ui.storageWarning.textContent =
                    'Low browser storage estimate: ' + formatModelSize(headroom.availableBytes) +
                    ' available, but ' + formatModelSize(headroom.requiredBytes) +
                    ' of additional model data is needed. The download may fail; ' +
                    'free storage or remove unused models.';
                ui.storageWarning.hidden = false;
            }
        } catch {
            // Failed quota inspection never blocks an explicitly requested download.
        }
    }
    if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');
}

async function doDownload(entry, ui) {
    const running = inFlightDownloads.get(entry.key);
    if (running) {
        running.abort();
        return;
    }
    if (!beginModelOperation(entry, ui, 'permission')) return;
    // Request only the selected asset host, before the first await so
    // Firefox preserves the user gesture. Neither host is granted by default.
    const manifest = entryManifest(entry);
    // A partially cached multi-asset model may expose Remove while Download
    // is still active. Keep cache mutation and inference mutually exclusive.
    const priorRemoveDisabled = ui.remove.disabled;
    const priorTestDisabled = ui.test.disabled;
    const priorChooseDisabled = ui.choose.disabled;
    ui.remove.disabled = true;
    ui.test.disabled = true;
    ui.choose.disabled = true;
    const restorePermissionActions = () => {
        ui.remove.disabled = priorRemoveDisabled;
        ui.test.disabled = priorTestDisabled;
        ui.choose.disabled = priorChooseDisabled;
    };
    ui.storageWarning.hidden = true;
    ui.storageWarning.textContent = '';
    ui.progress.hidden = false;
    // Browser Subresource Integrity may buffer an entire response before
    // exposing its stream. Keep the bar indeterminate until bytes are observed.
    ui.progress.removeAttribute('value');
    setMessage(ui.status, 'Waiting for model download permission…');
    const hostOrigin = new URL(manifest.assets[0].url).origin;
    let permissionPromise;
    try {
        permissionPromise = browser.permissions.request({
            origins: [hostOrigin + '/*'],
        });
    } catch (error) {
        ui.progress.hidden = true;
        setMessage(ui.status, 'Cannot request model download permission: ' + String(error.message || error));
        finishModelOperation(entry, ui);
        restorePermissionActions();
        return;
    }
    ui.download.disabled = true;
    let allowed;
    try {
        allowed = await permissionPromise;
    } catch (error) {
        ui.progress.hidden = true;
        setMessage(ui.status, 'Model download permission failed: ' + String(error.message || error));
        ui.download.disabled = false;
        finishModelOperation(entry, ui);
        restorePermissionActions();
        return;
    }
    if (!allowed) {
        ui.progress.hidden = true;
        setMessage(ui.status, 'Model download host permission was denied.');
        ui.download.disabled = false;
        finishModelOperation(entry, ui);
        restorePermissionActions();
        return;
    }
    const controller = new AbortController();
    ui.busy = 'download';
    inFlightDownloads.set(entry.key, controller);
    ui.download.disabled = false;
    ui.download.textContent = 'Cancel download';
    setMessage(ui.status, 'Connecting to the official model source (integrity checking may delay progress)…');
    let downloadError = null;
    try {
        await warnStorageHeadroom(manifest, ui, controller.signal);
        await cacheStore().install(manifest, {
            signal: controller.signal,
            onProgress: ({ completedBytes, totalBytes }) => {
                // Downloaded bytes are not yet committed to the cache. Do not
                // display a full bar until install() resolves successfully.
                const percent = Math.floor(100 * completedBytes / totalBytes);
                ui.progress.value = Math.min(99, Math.max(0, percent));
                setMessage(ui.status, 'Received ' + formatModelSize(completedBytes) + ' / ' +
                    formatModelSize(totalBytes) + ' (' + percent +
                    '%); validating and storing model data…');
            },
        });
    } catch (error) {
        downloadError = controller.signal.aborted ? 'Download cancelled.' :
            'Download failed: ' + String(error.message || error);
    } finally {
        inFlightDownloads.delete(entry.key);
        // Quota estimates describe an in-flight download, not the resulting
        // installed model or a completed failed/cancelled attempt.
        ui.storageWarning.hidden = true;
        ui.storageWarning.textContent = '';
        ui.busy = 'finalizing';
        ui.download.textContent = 'Download ' + formatModelSize(entry.totalBytes);
        ui.download.disabled = true;
        try {
            const state = await refresh(entry, ui);
            // Apply the fetched state synchronously after releasing the lock.
            // There is no window in which Download can start again before the
            // last cache inspection has established whether installation succeeded.
            finishModelOperation(entry, ui);
            applyModelStatus(entry, ui, state);
        } catch (error) {
            finishModelOperation(entry, ui);
            ui.download.disabled = false;
            ui.remove.disabled = priorRemoveDisabled;
            ui.test.disabled = priorTestDisabled;
            ui.choose.disabled = true;
            if (!downloadError) downloadError = 'Cannot inspect model cache: ' + String(error.message || error);
        }
        // The model status refresh must not erase the actual download failure.
        if (downloadError) {
            ui.progress.hidden = true;
            setMessage(ui.status, downloadError);
        } else {
            ui.progress.value = 100;
        }
    }
}

function currentEngine(entry) {
    if (engineByKey.has(entry.key)) return engineByKey.get(entry.key);
    const provider = entry.provider === 'mediapipe'
        ? new MediaPipeKokoroProvider({ variant: entry.variant })
        : new OnnxKokoroProvider({ variant: entry.variant });
    engineByKey.set(entry.key, provider);
    return provider;
}

async function testEngine(entry, ui) {
    if (entry.provider === 'dictionary' ||
        !beginModelOperation(entry, ui, 'test')) return;
    const priorRemoveDisabled = ui.remove.disabled;
    ui.remove.disabled = true; // Never evict a model while its runtime is executing.
    ui.test.disabled = true;
    ui.choose.disabled = true;
    const validationKey = 'mediapipeValidatedRevision:' + entry.variant;
    setMessage(ui.status, 'Loading locally packaged runtime and cached model…');
    try {
        await withModelDataLock(async () => {
            if (entry.provider === 'mediapipe') {
                // A failing re-test cannot leave its previous approval active.
                await browser.storage.local.remove(validationKey);
            }
            // An installed GPU model is not proof that this browser has a usable
            // GPU delegate. Do not initialize the official GPU runtime when the
            // browser cannot provide a WebGPU adapter; show a clear unavailable
            // result instead of surfacing an opaque upstream device.queue error.
            if (entry.provider === 'mediapipe' && entry.variant === 'gpu') {
                const capabilities = await window.KokoroBenchmark.inspectCapabilities();
                const gpuStatus = capabilities.webgpu?.status || 'unknown';
                if (gpuStatus !== 'adapter-available') {
                    setMessage(ui.status, 'GPU test unavailable in this browser (' + gpuStatus +
                        '). No inference was attempted. Try MediaPipe CPU instead.');
                    return;
                }
            }
            const engine = currentEngine(entry);
            await engine.initialize(); // Initialize outside warm-run timings.
            const text = document.getElementById('benchmarkText').value.trim();
            const ipa = document.getElementById('benchmarkIpa').value.trim();
            const runs = [];
            let last = null;
            for (let n = 0; n < 3; n++) {
                const started = performance.now();
                last = entry.provider === 'mediapipe'
                    ? await engine.synthesize(text)
                    : await engine.synthesizePhonemes(ipa);
                const elapsed = performance.now() - started;
                runs.push({ kind: 'warm', firstAudioMs: null, synthesisMs: elapsed,
                    audioDurationSec: last.samples.length / last.sampleRateHz });
            }
            // Keep the IPA measurements distinct from dictionary-backed text synthesis.
            // A failed or missing English lexicon must not erase a valid IPA probe.
            let englishResult = '';
            if (entry.provider === 'onnx') {
                if (!(await cacheStore().status(dictionaryManifest())).ready) {
                    englishResult = ' English text not tested: download the pronunciation dictionary first.';
                } else {
                    try {
                        const textAudio = await engine.synthesize(text);
                        last = textAudio;
                        englishResult = ' Experimental English text audio is ready to listen to.';
                    } catch (error) {
                        englishResult = ' English text synthesis failed: ' +
                            String(error.message || error) + '. Playing the IPA probe instead.';
                    }
                }
            }
            const metrics = window.KokoroBenchmark.summarizeRuns(runs);
            const previous = lastAudioUrl.get(entry.key);
            if (previous) URL.revokeObjectURL(previous);
            const audioUrl = URL.createObjectURL(pcmToWavBlob(last.samples, last.sampleRateHz));
            lastAudioUrl.set(entry.key, audioUrl);
            ui.audio.src = audioUrl;
            ui.audio.hidden = false;
            setMessage(ui.status, 'Real local inference, warm (3 runs). Full-clip synthesis p50: ' +
                metrics.synthesisP50Ms.toFixed(0) + ' ms, p95: ' +
                metrics.synthesisP95Ms.toFixed(0) + ' ms; RTF p50: ' +
                metrics.realTimeFactorP50.toFixed(2) +
                '. Streaming time-to-first-audio was not measured.' +
                (entry.provider === 'onnx'
                    ? ' Benchmark used IPA; English synthesis is a separate, unmeasured check.' +
                      englishResult + ' ONNX article/EPUB backend is not yet enabled.'
                    : ' Listen before choosing.'));
            // The ONNX text check is experimental, not an approval for general
            // article/EPUB usage. Keep its backend chooser disabled.
            if (entry.provider === 'mediapipe') {
                await browser.storage.local.set({
                    [validationKey]: manifestForVariant('mediapipe', entry.variant).revision,
                });
                ui.choose.disabled = false;
            }

        }, { mode: 'shared' });
    } catch (error) {
        setMessage(ui.status, 'Actual inference failed: ' + String(error.message || error));
    } finally {
        finishModelOperation(entry, ui);
        ui.test.disabled = false;
        ui.remove.disabled = priorRemoveDisabled;
    }
}

function registerModel(entry) {
    const ui = createModelRow(entry);
    ui.entry = entry;
    modelRows.set(entry.key, ui);
    page.appendChild(ui.row);
    ui.download.addEventListener('click', () => {
        void doDownload(entry, ui);
    });
    ui.remove.addEventListener('click', async () => {
        if (!beginModelOperation(entry, ui, 'remove')) return;
        ui.remove.disabled = true;
        ui.download.disabled = true;
        ui.test.disabled = true;
        ui.choose.disabled = true;
        try {
            const engine = engineByKey.get(entry.key);
            if (engine) {
                await engine.close();
                engineByKey.delete(entry.key);
            }
            await cacheStore().remove(entryManifest(entry));
            ui.progress.hidden = true;
            ui.storageWarning.hidden = true;
            if (entry.provider === 'dictionary') {
                // Invalidate in-memory lexicons after explicit removal.
                for (const [key, provider] of engineByKey.entries()) {
                    if (key.startsWith('onnx-')) {
                        await provider.close();
                        engineByKey.delete(key);
                    }
                }
            }
            if (entry.provider === 'mediapipe') {
                await browser.storage.local.remove('mediapipeValidatedRevision:' + entry.variant);
            }
        } catch (error) {
            setMessage(ui.status, 'Removal failed: ' + String(error.message || error));
        } finally {
            let finalState = null;
            try {
                finalState = await refresh(entry, ui);
            } catch (error) {
                setMessage(ui.status, 'Cannot inspect model cache after removal: ' +
                    String(error.message || error));
            } finally {
                finishModelOperation(entry, ui);
                // A successful test must not authorize a removed model.
                ui.choose.disabled = true;
                if (finalState) {
                    applyModelStatus(entry, ui, finalState);
                } else {
                    // A successful removal followed by a failed status probe
                    // must NOT revive stale "Installed" controls. Permit a
                    // fresh install to repair any partially removed assets.
                    ui.lastStatus = null;
                    ui.download.disabled = false;
                    ui.remove.disabled = true;
                    ui.test.disabled = true;
                    ui.choose.disabled = true;
                }
            }
        }
    });
    ui.test.addEventListener('click', () => {
        void testEngine(entry, ui);
    });
    ui.choose.addEventListener('click', async () => {
        if (entry.provider !== 'mediapipe' || ui.choose.disabled) return;
        await browser.storage.sync.set({ ttsBackend: 'mediapipe', mediaPipeVariant: entry.variant });
        setMessage(ui.status, 'MediaPipe selected for future article and EPUB TTS.');
    });
    void refresh(entry, ui).catch(error => {
        setMessage(ui.status, 'Cannot inspect extension Cache Storage: ' + String(error.message || error));
    });
}

async function testFastApi() {
    const button = document.getElementById('testServer');
    const choose = document.getElementById('chooseServer');
    const status = document.getElementById('serverStatus');
    choose.disabled = true;
    button.disabled = true;
    try {
        const settings = await browser.storage.sync.get({
            ttsBackend: 'fastapi', apiUrl: 'http://127.0.0.1:8880/v1/',
            voice: 'af_heart',
        });
        if (settings.ttsBackend !== 'fastapi') {
            throw new Error('Select the FastAPI backend first. Local-mode text is never sent to a server.');
        }
        const input = document.getElementById('benchmarkText').value.trim();
        if (!input || input.length > 20000) throw new TypeError('Enter a short text sample');
        const base = new URL(settings.apiUrl);
        if (!['http:', 'https:'].includes(base.protocol)) throw new TypeError('Unsupported server URL');
        const endpoint = new URL('audio/speech', base.href.endsWith('/') ? base : base.href + '/');
        setMessage(status, 'Testing the explicitly configured FastAPI server…');
        const started = performance.now();
        const result = await browser.runtime.sendMessage({
            action: 'FETCH_TTS_AUDIO', backend: 'fastapi', endpoint: endpoint.href,
            payload: { model: 'kokoro', input, voice: settings.voice,
                response_format: 'mp3', speed: 1 },
        });
        const elapsed = performance.now() - started;
        if (!result?.success || !result.dataUrl) throw new Error(result?.error || 'No MP3 data returned');
        const audio = document.getElementById('serverAudio');
        audio.src = result.dataUrl;
        audio.hidden = false;
        setMessage(status, 'Server returned playable MP3 in ' + elapsed.toFixed(0) +
            ' ms (network + synthesis; not a comparable local RTF).');
        choose.disabled = false;
    } catch (error) {
        setMessage(status, 'Server test failed: ' + String(error.message || error));
    } finally {
        button.disabled = false;
    }
}

if (page) {
    document.getElementById('testServer').addEventListener('click', () => {
        void testFastApi();
    });
    document.getElementById('chooseServer').addEventListener('click', async () => {
        await browser.storage.sync.set({ ttsBackend: 'fastapi' });
        setMessage(document.getElementById('serverStatus'), 'FastAPI selected.');
    });
    for (const entry of variants) registerModel(entry);
    window.addEventListener('pagehide', () => {
        for (const url of lastAudioUrl.values()) URL.revokeObjectURL(url);
        for (const controller of inFlightDownloads.values()) controller.abort();
        for (const engine of engineByKey.values()) void engine.close();
    });
}
