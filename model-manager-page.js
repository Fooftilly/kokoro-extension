// Extension-owned local model manager and *real* opt-in test harness.
// No model fetch occurs when this page loads, and local test inputs stay here.
import { listModelVariants, manifestForVariant, dictionaryManifest, modelDataProvenance } from './model-catalog.js';
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
const inFlightVerifications = new Map();
const lastAudioUrl = new Map();
const modelRows = new Map();
let activeModelOperation = null; // one mutating/inference operation per manager page
let initialStatusPending = true;
let recheckInProgress = false;
let modelStatusEpoch = 0; // A model operation invalidates older read-only scans.

function updateRecheckButton() {
    const busy = initialStatusPending || recheckInProgress || !!activeModelOperation;
    const recheck = document.getElementById('refreshModelCache');
    if (recheck) recheck.disabled = busy;
    const cleanup = document.getElementById('cleanOutdatedModels');
    if (cleanup) cleanup.disabled = busy;
}

function beginModelOperation(entry, ui, kind) {
    if (activeModelOperation || ui.busy) return false;
    const prior = new Map();
    activeModelOperation = { key: entry.key, prior };
    modelStatusEpoch++;
    ui.busy = kind;
    updateRecheckButton();
    // ONNX variants share a downloadable pronunciation dictionary. Removing
    // another row's assets while its engine is testing can corrupt inference.
    // Also avoid competing large writes and tests within this manager page.
    for (const [key, other] of modelRows) {
        if (key === entry.key) continue;
        prior.set(key, {
            download: other.download.disabled, remove: other.remove.disabled,
            verify: other.verify.disabled,
            test: other.test.disabled, choose: other.choose.disabled,
        });
        other.download.disabled = true;
        other.remove.disabled = true;
        other.verify.disabled = true;
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
    updateRecheckButton();
}

function cacheStore() {
    return new ModelDataStore({
        origin: browser.runtime.getURL('/'), cacheStorage: caches,
        fetchImpl: fetch.bind(globalThis),
        responseClass: Response, streamClass: TransformStream,
    });
}

// Explicitly reclaim old model revisions without affecting any variant in the
// current catalog. The exclusive cache lock waits for playback/tests in other
// extension contexts; the page operation lock disables local model controls.
async function cleanupObsoleteModelData() {
    if (initialStatusPending || recheckInProgress || activeModelOperation) return;
    if (!window.confirm('Remove only obsolete cached model revisions? All current MediaPipe, ONNX and dictionary assets will be kept.')) {
        return;
    }
    const cleanupEntry = { key: 'obsolete-cache' };
    const cleanupUi = { busy: null };
    if (!beginModelOperation(cleanupEntry, cleanupUi, 'cleanup')) return;
    const status = document.getElementById('modelCleanupStatus');
    status.textContent = 'Checking cached files for obsolete model revisions…';
    try {
        // Keep *all* pinned catalog variants, not merely the selected or fully
        // installed ones: partial downloads and alternative variants are valid.
        const retained = variants.map(entryManifest);
        const deleted = await cacheStore().removeUnreferenced(retained);
        status.textContent = 'Removed ' + deleted + ' obsolete cached asset(s). ' +
            'All current catalog variants and dictionary data were retained.';
    } catch (error) {
        status.textContent = 'Could not clean obsolete model cache: ' +
            String(error.message || error);
    } finally {
        finishModelOperation(cleanupEntry, cleanupUi);
    }
}

function setMessage(node, message) {
    node.textContent = message;
}

function displayModelStatus(entry, ready, totalBytes) {
    if (ready) return 'Installed (' + formatModelSize(totalBytes) +
        ' cached). Use Verify cached data to recheck SHA-256 integrity.';
    return 'Not installed — ' + formatModelSize(entry.totalBytes) + ' opt-in download';
}

function createModelRow(entry) {
    const row = document.createElement('article');
    row.className = 'model-variant';
    row.dataset.variant = entry.key;
    const title = document.createElement('h3');
    title.textContent = entry.label;
    const source = modelDataProvenance(entryManifest(entry));
    const provenance = document.createElement('p');
    provenance.className = 'model-provenance';
    const sourceLink = document.createElement('a');
    sourceLink.textContent = source.name;
    sourceLink.href = source.sourceUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    const licenseLink = document.createElement('a');
    licenseLink.textContent = source.license;
    licenseLink.href = source.licenseUrl;
    licenseLink.target = '_blank';
    licenseLink.rel = 'noopener noreferrer';
    provenance.append('Source: ', sourceLink, ' · License: ', licenseLink,
        ' · Pinned revision: ', source.revision.slice(0, 7),
        ' · Model data to download and cache: ', formatModelSize(entry.totalBytes),
        ' (browser storage overhead may add to this).');
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
    const verify = document.createElement('button');
    verify.type = 'button';
    verify.textContent = 'Verify cached data';
    verify.className = 'model-verify';
    verify.disabled = true;
    verify.title = 'Reads cached SHA-256. Click again during verification to cancel.';
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
    actions.append(download, remove, verify, test, choose);
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.hidden = true;
    row.append(title, provenance, status, storageWarning, progress, actions, audio);
    return { row, status, storageWarning, progress, download, remove, verify, test, choose,
        audio, busy: null };
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
    ui.verify.disabled = blocked || !state.storedBytes;
    ui.download.disabled = ui.busy === 'download' ? false : blocked || state.ready;
    if (blocked || !state.ready) ui.choose.disabled = true;
}

async function refresh(entry, ui) {
    const state = await cacheStore().status(entryManifest(entry));
    applyModelStatus(entry, ui, state);
    return state;
}

function applyRecheckedModelStatuses(snapshots) {
    let changed = 0;
    let missing = 0;
    for (const { entry, state } of snapshots) {
        const ui = modelRows.get(entry.key);
        const previous = ui.lastStatus;
        const differs = !previous || previous.ready !== state.ready ||
            previous.storedBytes !== state.storedBytes;
        const evicted = previous?.ready && !state.ready;
        if (differs) changed++;
        if (evicted) missing++;
        applyModelStatus(entry, ui, state, { updateMessage: differs });
        if (evicted) {
            setMessage(ui.status, 'Cached model data is missing. Download again to repair it.');
        }
    }
    if (missing) {
        return 'Cache rechecked: ' + missing + ' previously installed model(s) lost data. ' +
            'Use Download to repair them.';
    }
    if (changed) return 'Cache rechecked: ' + changed + ' model status(es) changed.';
    return 'Cache rechecked: all model statuses unchanged.';
}

// Cache entries may disappear because another extension tab removes a model,
// or because the browser evicts origin storage. A shared read lease observes a
// consistent set of manifests without starting downloads or loading any engine.
// Keep benchmark results visible when the underlying cache state is unchanged.
async function recheckModelCache() {
    if (initialStatusPending || recheckInProgress || activeModelOperation) return;
    const epoch = modelStatusEpoch;
    recheckInProgress = true;
    updateRecheckButton();
    const summary = document.getElementById('modelRecheckStatus');
    setMessage(summary, 'Rechecking installed model data…');
    try {
        const snapshots = await withModelDataLock(async () => {
            const store = cacheStore();
            return Promise.all(variants.map(async entry => ({
                entry, state: await store.status(entryManifest(entry)),
            })));
        }, { mode: 'shared' });
        if (epoch !== modelStatusEpoch || activeModelOperation) return;
        setMessage(summary, applyRecheckedModelStatuses(snapshots));
    } catch (error) {
        if (epoch === modelStatusEpoch && !activeModelOperation) {
            setMessage(summary, 'Cannot recheck model cache: ' + String(error.message || error));
        }
    } finally {
        if ((epoch !== modelStatusEpoch || activeModelOperation) &&
            summary.textContent === 'Rechecking installed model data…') {
            setMessage(summary, 'Cache recheck superseded by a model operation.');
        }
        recheckInProgress = false;
        updateRecheckButton();
    }
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
    const priorVerifyDisabled = ui.verify.disabled;
    const priorChooseDisabled = ui.choose.disabled;
    ui.remove.disabled = true;
    ui.verify.disabled = true;
    ui.test.disabled = true;
    ui.choose.disabled = true;
    const restorePermissionActions = () => {
        ui.remove.disabled = priorRemoveDisabled;
        ui.verify.disabled = priorVerifyDisabled;
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
            ui.verify.disabled = priorVerifyDisabled;
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
    const priorVerifyDisabled = ui.verify.disabled;
    ui.remove.disabled = true; // Never evict a model while its runtime is executing.
    ui.verify.disabled = true;
    ui.test.disabled = true;
    ui.choose.disabled = true;
    const validationKey = entry.provider === 'mediapipe'
        ? 'mediapipeValidatedRevision:' + entry.variant
        : 'onnxValidatedRevision:q8';
    setMessage(ui.status, 'Loading locally packaged runtime and cached model…');
    try {
        await withModelDataLock(async () => {
            if (entry.provider === 'mediapipe' ||
                (entry.provider === 'onnx' && entry.variant === 'q8')) {
                // A failing re-test cannot leave a previous text-capable
                // backend approval active, even when its IPA probe succeeds.
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
            let englishReady = false;
            if (entry.provider === 'onnx') {
                if (!(await cacheStore().status(dictionaryManifest())).ready) {
                    englishResult = ' English text not tested: download the pronunciation dictionary first.';
                } else {
                    try {
                        const textAudio = await engine.synthesize(text);
                        last = textAudio;
                        englishReady = true;
                        englishResult = ' Experimental dictionary-backed English text audio is ready to listen to.';
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
                      englishResult + ' Unknown English words are not supported and never fall back to FastAPI.'
                    : ' Listen before choosing.'));
            // ONNX regular reading is deliberately limited to the validated
            // q8 + cached English dictionary path, not IPA-only probes or
            // unverified q8f16/GPU variants. Test failures never enable it.
            if (entry.provider === 'mediapipe' ||
                (entry.provider === 'onnx' && entry.variant === 'q8' && englishReady)) {
                await browser.storage.local.set({
                    [validationKey]: manifestForVariant(entry.provider, entry.variant).revision,
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
        ui.verify.disabled = priorVerifyDisabled;
    }
}

async function invalidateRuntimeFor(entry) {
    const keys = entry.provider === 'dictionary'
        ? [...engineByKey.keys()].filter(key => key.startsWith('onnx-'))
        : [entry.key];
    for (const key of keys) {
        const engine = engineByKey.get(key);
        if (!engine) continue;
        engineByKey.delete(key);
        await engine.close();
    }
    if (entry.provider === 'mediapipe') {
        await browser.storage.local.remove('mediapipeValidatedRevision:' + entry.variant);
    }
    if (entry.provider === 'dictionary' ||
        (entry.provider === 'onnx' && entry.variant === 'q8')) {
        await browser.storage.local.remove('onnxValidatedRevision:q8');
    }
}

function verificationResultMessage(result) {
    if (result.removedAssets) {
        return 'Removed ' + result.removedAssets +
            ' corrupted cached asset(s). Click Download to repair the model.';
    }
    if (result.missingAssets) {
        return 'Cache verification found ' + result.missingAssets +
            ' missing asset(s). Click Download to repair the model.';
    }
    return 'Cached model data verified: ' +
        formatModelSize(result.verifiedBytes) + ' matches its pinned SHA-256 hashes.';
}

// Explicit, offline SHA-256 verification. A mismatch is repaired only by
// evicting the affected cached asset; downloading it again always requires the
// user's separate Download action. The exclusive cache lease also prevents
// reading or deleting a model during local inference in another extension tab.
async function verifyCachedData(entry, ui) {
    const running = inFlightVerifications.get(entry.key);
    if (running) {
        running.abort();
        ui.verify.disabled = true;
        setMessage(ui.status, 'Cancelling cache verification…');
        return;
    }
    if (!beginModelOperation(entry, ui, 'verify')) return;
    const controller = new AbortController();
    inFlightVerifications.set(entry.key, controller);
    const priorChooseEnabled = !ui.choose.disabled;
    ui.download.disabled = true;
    ui.remove.disabled = true;
    ui.verify.disabled = false;
    ui.verify.textContent = 'Cancel verification';
    ui.test.disabled = true;
    ui.choose.disabled = true;
    let removed = 0;
    let result = null;
    let message;
    setMessage(ui.status, 'Checking cached SHA-256 integrity. This may use substantial memory…');
    try {
        result = await cacheStore().verifyAndPruneCorrupt(entryManifest(entry), {
            signal: controller.signal,
            onProgress: progress => {
                removed = progress.removedAssets;
                setMessage(ui.status, 'Verified ' + formatModelSize(progress.verifiedBytes) +
                    ' of ' + formatModelSize(progress.totalBytes) + ' of cached data…');
            },
        });
        removed = result.removedAssets;
        message = verificationResultMessage(result);
    } catch (error) {
        message = controller.signal.aborted
            ? 'Cache verification cancelled. No model data was downloaded.'
            : 'Cache verification failed without automatic download: ' +
                String(error.message || error);
    } finally {
        inFlightVerifications.delete(entry.key);
        ui.verify.textContent = 'Verify cached data';
        ui.verify.disabled = true;
        ui.busy = 'finalizing';
        if (removed) {
            try {
                await invalidateRuntimeFor(entry);
            } catch (error) {
                message += ' Could not reset the cached engine: ' + String(error.message || error);
            }
        }
        let state = null;
        try {
            state = await refresh(entry, ui);
        } catch (error) {
            message += ' Could not inspect cache: ' + String(error.message || error);
        }
        finishModelOperation(entry, ui);
        if (state) {
            applyModelStatus(entry, ui, state);
            // Preserve a prior user-validated backend only if no bytes were
            // removed and the model remains installed.
            ui.choose.disabled = !priorChooseEnabled || removed > 0 || !state.ready;
        } else {
            ui.lastStatus = null;
            ui.download.disabled = false;
            ui.remove.disabled = true;
            ui.verify.disabled = true;
            ui.test.disabled = true;
            ui.choose.disabled = true;
        }
        setMessage(ui.status, message);
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
        ui.verify.disabled = true;
        ui.test.disabled = true;
        ui.choose.disabled = true;
        try {
            await invalidateRuntimeFor(entry);
            await cacheStore().remove(entryManifest(entry));
            ui.progress.hidden = true;
            ui.storageWarning.hidden = true;
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
                    ui.verify.disabled = true;
                    ui.test.disabled = true;
                    ui.choose.disabled = true;
                }
            }
        }
    });
    ui.verify.addEventListener('click', () => {
        void verifyCachedData(entry, ui);
    });
    ui.test.addEventListener('click', () => {
        void testEngine(entry, ui);
    });
    ui.choose.addEventListener('click', async () => {
        if (ui.choose.disabled || (entry.provider !== 'mediapipe' &&
            !(entry.provider === 'onnx' && entry.variant === 'q8'))) return;
        if (entry.provider === 'onnx') {
            const [model, dictionary] = await Promise.all([
                cacheStore().status(entryManifest(entry)),
                cacheStore().status(dictionaryManifest()),
            ]);
            if (!model.ready || !dictionary.ready) {
                ui.choose.disabled = true;
                setMessage(ui.status, 'ONNX q8 or English dictionary is missing. Download and retest before selecting.');
                return;
            }
            await browser.storage.sync.set({ ttsBackend: 'onnx' });
            setMessage(ui.status, 'ONNX q8 selected for dictionary-supported English reading. Unknown words fail without server fallback.');
        } else {
            await browser.storage.sync.set({ ttsBackend: 'mediapipe', mediaPipeVariant: entry.variant });
            setMessage(ui.status, 'MediaPipe selected for future article and EPUB TTS.');
        }
    });
    return refresh(entry, ui).catch(error => {
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
    document.getElementById('refreshModelCache').addEventListener('click', () => {
        void recheckModelCache();
    });
    document.getElementById('cleanOutdatedModels').addEventListener('click', () => {
        void cleanupObsoleteModelData();
    });
    const onFocus = () => { void recheckModelCache(); };
    const onVisible = () => {
        if (document.visibilityState === 'visible') void recheckModelCache();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const initialReads = variants.map(registerModel);
    void Promise.allSettled(initialReads).then(() => {
        initialStatusPending = false;
        setMessage(document.getElementById('modelRecheckStatus'),
            'Model statuses checked. Recheck to detect storage eviction or changes in other tabs.');
        updateRecheckButton();
    });
    window.addEventListener('pagehide', () => {
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisible);
        for (const url of lastAudioUrl.values()) URL.revokeObjectURL(url);
        for (const controller of inFlightDownloads.values()) controller.abort();
        for (const controller of inFlightVerifications.values()) controller.abort();
        for (const engine of engineByKey.values()) void engine.close();
    });
}
