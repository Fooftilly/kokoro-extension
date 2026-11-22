// Extension-owned local model manager and *real* opt-in test harness.
// No model fetch occurs when this page loads, and local test inputs stay here.
import { listModelVariants, listPinnedModelVariants, manifestForVariant,
    dictionaryManifest, modelDataProvenance } from './model-catalog.js';
import { ModelDataStore, formatModelSize, assessStorageHeadroom } from './model-data-store.js';
import { withModelDataLock } from './model-data-lock.js';
import { MediaPipeKokoroProvider } from './mediapipe-provider.js';
import { OnnxKokoroProvider } from './onnx-provider.js';
import { pcmToWavBlob } from './pcm-wav.js';
import {
    LONGER_SHARED_ENGLISH_SAMPLE,
    LONGER_SHARED_ENGLISH_BUTTON_ID,
} from './longer-shared-english-sample.js';
import { discloseStoreSigning } from './store-signing-disclosure.js';
import { waitServerAudioPlaybackStart } from './server-audio-playback-start.js';
import {
    DEFAULT_PROGRESSIVE_TTFA_TIMEOUT_MS,
    measureProgressiveMediaSourceTtfa,
    probeMediaSourceProgressiveMp3Support,
    progressiveTtfaUnavailable,
    cancelReadableStreamBody,
    readBoundedResponseText,
} from './mediasource-progressive-ttfa.js';

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
const sharedEnglishResults = new Map(); // in-page only; never stored or uploaded
let sharedEnglishEpoch = 0; // invalidate asynchronous results after sample edits
let activeModelOperation = null; // one mutating/inference operation per manager page
let initialStatusPending = true;
let recheckInProgress = false;
let modelStatusEpoch = 0; // A model operation invalidates older read-only scans.

// Summarize only real, successful warm synthesis of the same current English
// sample. The table deliberately excludes IPA probes and FastAPI latency.
function renderSharedEnglishResults() {
    const tbody = document.getElementById('sharedEnglishComparisonRows');
    const status = document.getElementById('sharedEnglishComparisonStatus');
    if (!tbody || !status) return;
    tbody.replaceChildren();
    for (const entry of variants) {
        const result = sharedEnglishResults.get(entry.key);
        if (!result) continue;
        const row = document.createElement('tr');
        row.dataset.backend = entry.key;
        for (const value of [
            entry.label,
            result.coldPrepMs.toFixed(0) + ' ms',
            result.synthesisP50Ms.toFixed(0) + ' ms',
            result.synthesisP95Ms.toFixed(0) + ' ms',
            result.realTimeFactorP50.toFixed(2),
        ]) {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.appendChild(cell);
        }
        tbody.appendChild(row);
    }
    status.textContent = sharedEnglishResults.size >= 2
        ? 'Measured ' + sharedEnglishResults.size +
            ' local backend paths on the current English sample (cold prep + three warm runs each). No ranking is inferred.'
        : sharedEnglishResults.size === 1
            ? 'One local backend measured. Test another on the same English sample to compare.'
            : 'Run at least two local English tests to compare their measured timings.';
    updateMeasuredExportButton();
}

// Snapshot shared-English metrics before any await so mid-probe sample edits
// or model removals cannot leave undefined result rows.
function snapshotMeasuredEnglishRows() {
    const rows = [];
    for (const entry of variants) {
        const result = sharedEnglishResults.get(entry.key);
        if (!result) continue;
        rows.push({
            entry,
            coldPrepMs: result.coldPrepMs,
            synthesisP50Ms: result.synthesisP50Ms,
            synthesisP95Ms: result.synthesisP95Ms,
            realTimeFactorP50: result.realTimeFactorP50,
            playbackStartP50Ms: result.playbackStartP50Ms,
            cancelJoinP50Ms: result.cancelJoinP50Ms,
        });
    }
    return rows;
}

// Probe real Cache Storage body sizes (blob.size) under a shared lock.
// Falls back to empty maps on failure so export stays catalog-only / unmeasured.
async function probeCachedBodyBytes(snappedRows) {
    let cacheByKey = new Map();
    let dictionaryMeasuredBytes = null;
    try {
        await withModelDataLock(async () => {
            const store = cacheStore();
            const pairs = await Promise.all(snappedRows.map(async ({ entry }) => {
                const state = await store.measureBodyBytes(entryManifest(entry));
                return [entry.key, state];
            }));
            cacheByKey = new Map(pairs);
            if (snappedRows.some(({ entry }) => entry.provider === 'onnx')) {
                const dictState = await store.measureBodyBytes(dictionaryManifest());
                dictionaryMeasuredBytes = dictState.complete
                    ? dictState.measuredBytes : null;
            }
        }, { mode: 'shared' });
    } catch (_) {
        return { cacheByKey: new Map(), dictionaryMeasuredBytes: null };
    }
    return { cacheByKey, dictionaryMeasuredBytes };
}

function attachMeasuredCacheBodyFields(row, entry, cacheByKey,
    dictionaryMeasuredBytes, englishDictionaryCatalogBytes) {
    let measuredOk = true;
    const state = cacheByKey.get(entry.key);
    const measured = state?.complete === true ? state.measuredBytes : null;
    if (Number.isFinite(measured) && measured > 0 &&
        measured === entry.totalBytes) {
        row.cachedCatalogAssetBytes = measured;
        row.measuredCacheBodyBytes = measured;
    } else {
        measuredOk = false;
    }
    if (entry.provider !== 'onnx') return measuredOk;
    row.requiredDictionaryCatalogBytes = englishDictionaryCatalogBytes;
    row.catalogEnglishPathBytes = entry.totalBytes + englishDictionaryCatalogBytes;
    if (Number.isFinite(dictionaryMeasuredBytes) && dictionaryMeasuredBytes > 0 &&
        Number.isFinite(measured) && measured > 0) {
        row.cachedCatalogDictionaryBytes = dictionaryMeasuredBytes;
        row.measuredCacheDictionaryBytes = dictionaryMeasuredBytes;
        row.cachedCatalogEnglishPathBytes = measured + dictionaryMeasuredBytes;
    } else {
        measuredOk = false;
    }
    return measuredOk;
}

// #61: optional local-only JSON export of measured English rows (no telemetry).
// Cache presence probe is best-effort under a shared lock; catalog fields stay.
async function buildMeasuredEnglishExport() {
    const sampleText = document.getElementById('benchmarkText')?.value.trim() || '';
    const englishDictionaryCatalogBytes = dictionary.assets.reduce(
        (sum, asset) => sum + asset.bytes, 0);
    const snappedRows = snapshotMeasuredEnglishRows();
    const { cacheByKey, dictionaryMeasuredBytes } =
        await probeCachedBodyBytes(snappedRows);
    const measurements = [];
    let allBodiesMeasured = snappedRows.length > 0;
    for (const snapped of snappedRows) {
        const { entry } = snapped;
        const row = {
            key: entry.key,
            label: entry.label,
            coldPrepMs: snapped.coldPrepMs,
            synthesisP50Ms: snapped.synthesisP50Ms,
            synthesisP95Ms: snapped.synthesisP95Ms,
            realTimeFactorP50: snapped.realTimeFactorP50,
            playbackStartP50Ms: snapped.playbackStartP50Ms,
            cancelJoinP50Ms: snapped.cancelJoinP50Ms,
            // Static pinned catalog asset sum (KE-38).
            catalogModelAssetBytes: entry.totalBytes,
        };
        if (!attachMeasuredCacheBodyFields(row, entry, cacheByKey,
            dictionaryMeasuredBytes, englishDictionaryCatalogBytes)) {
            allBodiesMeasured = false;
        }
        measurements.push(row);
    }
    const allPlaybackStartsMeasured = measurements.length > 0 &&
        measurements.every(row => Number.isFinite(row.playbackStartP50Ms) &&
            row.playbackStartP50Ms >= row.synthesisP50Ms);
    const allCancelJoinsMeasured = measurements.length > 0 &&
        measurements.every(row => Number.isFinite(row.cancelJoinP50Ms) &&
            row.cancelJoinP50Ms >= 0);
    return {
        kind: 'kokoro-measured-local-english',
        localOnly: true,
        telemetry: false,
        noRanking: true,
        measurementKind: 'warm-full-clip-synthesis',
        coldPrepMeasured: true,
        firstAudioMeasured: false,
        // Full-clip muted HTMLAudioElement start (encode WAV → playing).
        // Not streaming / MediaSource TTFA.
        localPlaybackStartMeasured: allPlaybackStartsMeasured,
        // Cancel → synthesize settlement join (best-effort; not force-interrupt).
        localCancelMeasured: allCancelJoinsMeasured,
        nativeForceInterruptSupported: false,
        // Real Cache Storage body sizes (blob.size), not catalog-header presence.
        storageFootprintMeasured: allBodiesMeasured,
        storageFootprintSource: allBodiesMeasured
            ? 'cache-body-bytes' : 'catalog',
        cachePresenceProbed: allBodiesMeasured,
        englishDictionaryCatalogBytes,
        // Do not invent runtime heap; Chrome performance.memory is optional
        // and not comparable across engines.
        runtimeHeapMeasured: false,
        // #61 / KE-46: do not claim Chrome Web Store / AMO package signing.
        storeSigning: discloseStoreSigning(),
        sampleText,
        browser: {
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
            online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        },
        measurements,
        exportedAt: new Date().toISOString(),
    };
}

function updateMeasuredExportButton() {
    const button = document.getElementById('exportMeasuredResults');
    if (button) button.disabled = sharedEnglishResults.size === 0;
}

// Await downloads.onChanged for this export id. Resolving on download() alone
// would flash success while the JSON is still writing; treating interrupted
// like complete would revoke the blob and leave a false success status.
async function downloadPinnedMeasuredExport(url, filename) {
    const release = () => {
        try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    };
    const events = browser.downloads?.onChanged;
    if (!events?.addListener || !events?.removeListener ||
        typeof browser.downloads?.download !== 'function') {
        throw new Error('downloads API unavailable for measured export');
    }
    let downloadId = null;
    let finished = false;
    const earlyTerminals = new Map();
    let settle;
    const done = new Promise((resolve, reject) => {
        settle = { resolve, reject };
    });
    const finish = (error, id) => {
        if (finished) return;
        finished = true;
        events.removeListener(onChanged);
        release();
        if (error) settle.reject(error);
        else settle.resolve(id);
    };
    const onChanged = delta => {
        const state = delta.state?.current;
        if (state !== 'complete' && state !== 'interrupted') return;
        if (downloadId === null) {
            earlyTerminals.set(delta.id, state);
            return;
        }
        if (delta.id !== downloadId) return;
        if (state === 'interrupted') {
            finish(new Error('Measured export download interrupted'));
        } else {
            finish(null, downloadId);
        }
    };
    try {
        events.addListener(onChanged);
        downloadId = await browser.downloads.download({
            url, filename, saveAs: false,
        });
        const early = earlyTerminals.get(downloadId);
        if (early === 'interrupted') {
            finish(new Error('Measured export download interrupted'));
        } else if (early === 'complete') {
            finish(null, downloadId);
        }
        return await done;
    } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return await done;
    }
}

async function exportMeasuredEnglishResults() {
    const status = document.getElementById('measuredExportStatus');
    const payload = await buildMeasuredEnglishExport();
    if (!payload.measurements.length) {
        if (status) status.textContent = 'No measured local English results to export.';
        return;
    }
    globalThis.__kokoroLastMeasuredExport = payload;
    delete globalThis.__kokoroLastMeasuredExportDownloadId;
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
        const downloadId = await downloadPinnedMeasuredExport(
            url, 'kokoro-measured-local-english.json');
        globalThis.__kokoroLastMeasuredExportDownloadId = downloadId;
        if (status) {
            status.textContent =
                'Measured results exported locally. Nothing was uploaded.';
        }
    } catch (error) {
        try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
        if (status) {
            status.textContent = 'Measured export failed: ' +
                (error?.message || String(error));
        }
    }
}

function forgetSharedEnglishResult(entry) {
    let removed = false;
    for (const key of [...sharedEnglishResults.keys()]) {
        if (key === entry.key ||
            (entry.provider === 'dictionary' && key.startsWith('onnx-'))) {
            removed = sharedEnglishResults.delete(key) || removed;
        }
    }
    if (removed) renderSharedEnglishResults();
}

function rememberSharedEnglishResult(entry, metrics, text, epoch) {
    const input = document.getElementById('benchmarkText');
    if (epoch !== sharedEnglishEpoch || input?.value.trim() !== text) return;
    if (![metrics.coldPrepMs, metrics.synthesisP50Ms, metrics.synthesisP95Ms,
        metrics.realTimeFactorP50].every(v => Number.isFinite(v) && v >= 0)) {
        return;
    }
    // Playback start / cancel-join are optional for approval/table presence;
    // export still fail-closes measured flags when any English row lacks them.
    if (metrics.playbackStartP50Ms != null &&
        !(Number.isFinite(metrics.playbackStartP50Ms) &&
            metrics.playbackStartP50Ms >= metrics.synthesisP50Ms)) {
        return;
    }
    if (metrics.cancelJoinP50Ms != null &&
        !(Number.isFinite(metrics.cancelJoinP50Ms) &&
            metrics.cancelJoinP50Ms >= 0)) {
        return;
    }
    sharedEnglishResults.set(entry.key, metrics);
    renderSharedEnglishResults();
}

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
        // Retain every pinned manifest (including offered:false GPU) so cleanup
        // never treats a still-current pin as obsolete (#58 / #147).
        const retained = [
            ...listPinnedModelVariants().map(entry =>
                manifestForVariant(entry.provider, entry.variant)),
            dictionaryManifest(),
        ];
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
    const Disclosure = globalThis.KokoroBackendDisclosure;
    const sizePhrase = Disclosure && typeof Disclosure.modelDataFootprintLabel === 'function'
        ? Disclosure.modelDataFootprintLabel(entry, formatModelSize)
        : formatModelSize(entry.totalBytes);
    const sizeHeading = entry.provider === 'onnx'
        ? 'Total model-data footprint: '
        : 'Model data to download and cache: ';
    provenance.append('Source: ', sourceLink, ' · License: ', licenseLink,
        ' · Pinned revision: ', source.revision.slice(0, 7),
        ' · ', sizeHeading, sizePhrase,
        ' (browser storage overhead may add to this).');
    const footprint = document.createElement('p');
    footprint.className = 'model-footprint-note';
    const footprintNote = Disclosure && typeof Disclosure.downloadFootprintNote === 'function'
        ? Disclosure.downloadFootprintNote(entry)
        : '';
    if (footprintNote) footprint.textContent = footprintNote;
    else footprint.hidden = true;
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
    row.append(title, provenance, footprint, status, storageWarning, progress, actions, audio);
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
            forgetSharedEnglishResult(entry);
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

// Measure full-clip synthesis; muted HTMLAudioElement playback start is
// best-effort and must not block backend approval when synthesis succeeded.
// Streaming time-to-first-audio stays unmeasured (firstAudioMs null). Only
// group runs for the *same input and provider path*; a failed English run must
// never be mixed with IPA timings or count towards backend approval.
async function measureWarmClip(synthesize) {
    const runs = [];
    let audio = null;
    for (let n = 0; n < 3; n++) {
        const started = performance.now();
        audio = await synthesize();
        const synthesisMs = performance.now() - started;
        let playbackStartMs = null;
        const blob = pcmToWavBlob(audio.samples, audio.sampleRateHz);
        const objectUrl = URL.createObjectURL(blob);
        const el = new Audio();
        try {
            el.src = objectUrl;
            // playingAtMs is captured in the `playing` handler (before cleanup).
            const playingAtMs = await waitServerAudioPlaybackStart(el);
            const elapsed = playingAtMs - started;
            if (Number.isFinite(elapsed) && elapsed >= synthesisMs) {
                playbackStartMs = elapsed;
            }
        } catch {
            // Audio-element quirks must not invalidate successful synthesis.
            playbackStartMs = null;
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
        runs.push({
            kind: 'warm',
            firstAudioMs: null,
            synthesisMs,
            playbackStartMs,
            audioDurationSec: audio.samples.length / audio.sampleRateHz,
        });
    }
    return { runs, audio };
}

/**
 * Wall time from cancel() until the in-flight synthesize settles (join).
 * ONNX cannot force-interrupt InferenceSession.run(); MediaPipe cancel is
 * best-effort. Never claim native force-interrupt from this measurement.
 */
async function measureCancelJoin(engine, synthesize) {
    if (!engine || typeof engine.cancel !== 'function') {
        throw new TypeError('Local engine cancel() required for cancel-join');
    }
    const joins = [];
    for (let n = 0; n < 3; n++) {
        const started = performance.now();
        const pending = Promise.resolve().then(() => synthesize());
        await Promise.resolve();
        await engine.cancel();
        try {
            await pending;
        } catch (_) {
            // AbortError / cancelled settlement is expected after cancel.
        }
        const joinMs = performance.now() - started;
        if (!Number.isFinite(joinMs) || joinMs < 0) {
            throw new Error('Cancel join measurement failed');
        }
        joins.push(joinMs);
    }
    return joins;
}

// ONNX q8 can benchmark the *same English input* as MediaPipe only when its
// verified dictionary resolves every word. Otherwise use an explicitly
// non-comparable IPA diagnostic without authorizing regular English playback.
async function testOnnxEnglishText(engine, text, coldStartedAt) {
    if (!text || !(await cacheStore().status(dictionaryManifest())).ready) {
        return { ready: false, measured: null, coldPrepMs: null,
            message: !text
                ? ' English text not tested: enter an English sample.'
                : ' English text not tested: download the pronunciation dictionary first.' };
    }
    try {
        // The first English synthesis lazily reads, verifies and parses the
        // dictionary, and may warm up the ONNX runtime. Exclude all such cold
        // preparation from the three runs labeled as warm measurements.
        // A failed warm-up must still lead to IPA-only diagnostics, not approval.
        await engine.synthesize(text);
        const coldPrepMs = performance.now() - coldStartedAt;
        const measured = await measureWarmClip(() => engine.synthesize(text));
        return { ready: true, measured, coldPrepMs,
            message: ' Measured the shared English text through the dictionary-backed ONNX path (after untimed warm-up).' };
    } catch (error) {
        return { ready: false, measured: null, coldPrepMs: null,
            message: ' English text synthesis failed: ' +
                String(error.message || error) + '. Playing the IPA probe instead.' };
    }
}

// The sample path and preparation belong together, not in the UI's model
// operation state machine. IPA measurements stay isolated from English data.
// coldStartedAt marks initialize(); coldPrepMs ends after the first synth.
async function measureBackendSample(entry, engine, text, ipa, coldStartedAt) {
    const english = entry.provider === 'onnx' && entry.variant === 'q8'
        ? await testOnnxEnglishText(engine, text, coldStartedAt) : null;
    const englishReady = english?.ready === true;
    let coldPrepMs = english?.coldPrepMs ?? null;
    // MediaPipe can also do lazy setup on its first synthesis.
    if (entry.provider === 'mediapipe') {
        await engine.synthesize(text);
        coldPrepMs = performance.now() - coldStartedAt;
    }
    const measured = english?.measured || await measureWarmClip(
        entry.provider === 'mediapipe'
            ? () => engine.synthesize(text)
            : () => engine.synthesizePhonemes(ipa));
    return {
        english,
        englishReady,
        measured,
        coldPrepMs,
        isEnglishMeasurement: entry.provider === 'mediapipe' || englishReady,
    };
}

function formatLocalBenchmarkStatus(entry, metrics, isEnglishMeasurement, english) {
    const coldNote = Number.isFinite(metrics.coldPrepMs)
        ? ' Cold prep (init + first synth): ' +
            metrics.coldPrepMs.toFixed(0) + ' ms.'
        : '';
    const playbackNote = Number.isFinite(metrics.playbackStartP50Ms)
        ? ' Full-clip muted playback start p50: ' +
            metrics.playbackStartP50Ms.toFixed(0) + ' ms.'
        : ' Full-clip muted playback start was not measured' +
            ' (synthesis still valid for backend approval).';
    const cancelNote = Number.isFinite(metrics.cancelJoinP50Ms)
        ? ' Cancel-join p50: ' + metrics.cancelJoinP50Ms.toFixed(0) +
            ' ms (best-effort; native force-interrupt not supported).'
        : ' Cancel-join was not measured.';
    return 'Real local inference, warm (3 runs, ' +
        (isEnglishMeasurement ? 'shared English text' : 'IPA-only diagnostic') +
        '). Full-clip synthesis p50: ' +
        metrics.synthesisP50Ms.toFixed(0) + ' ms, p95: ' +
        metrics.synthesisP95Ms.toFixed(0) + ' ms; RTF p50: ' +
        metrics.realTimeFactorP50.toFixed(2) + '.' + coldNote + playbackNote +
        cancelNote +
        ' Streaming time-to-first-audio was not measured.' +
        (entry.provider === 'onnx'
            ? (isEnglishMeasurement
                ? ' Same English text as MediaPipe; voices and phonemization may differ. Local backends use a single voice (no weighted FastAPI-style mix).'
                : ' IPA timings are not comparable with English-text timings.') +
              (english?.message || ' This ONNX variant is IPA-only; regular English playback is not validated.') +
              ' Unknown English words are not supported and never fall back to FastAPI.'
            : ' Listen before choosing.');
}

// Clear stale approval before a retest, then write it back only when the
// actual backend-specific text test passes. The IPA-only ONNX q8f16 probe
// never grants regular playback privileges.
async function clearModelTestApproval(entry, validationKey) {
    if (entry.provider === 'mediapipe' ||
        (entry.provider === 'onnx' && entry.variant === 'q8')) {
        await browser.storage.local.remove(validationKey);
    }
}

async function approveTestedBackend(entry, ui, validationKey, englishReady) {
    if (entry.provider !== 'mediapipe' &&
        !(entry.provider === 'onnx' && entry.variant === 'q8' && englishReady)) return;
    await browser.storage.local.set({
        [validationKey]: manifestForVariant(entry.provider, entry.variant).revision,
    });
    ui.choose.disabled = false;
}

async function testEngine(entry, ui) {
    if (entry.provider === 'dictionary' ||
        !beginModelOperation(entry, ui, 'test')) return;
    // A failed/unsupported retest must not leave an obsolete comparison.
    forgetSharedEnglishResult(entry);
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
            await clearModelTestApproval(entry, validationKey);
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
            // Cold prep spans initialize + first untimed synthesis; warm runs
            // start only after that window closes (KE-31 / #61 disclosure).
            const coldStartedAt = performance.now();
            await engine.initialize();
            const text = document.getElementById('benchmarkText').value.trim();
            const sampleEpoch = sharedEnglishEpoch;
            const ipa = document.getElementById('benchmarkIpa').value.trim();
            const { english, englishReady, measured, coldPrepMs,
                isEnglishMeasurement } =
                await measureBackendSample(entry, engine, text, ipa, coldStartedAt);
            const playbackSamples = measured.runs
                .map(r => r.playbackStartMs)
                .filter(v => Number.isFinite(v));
            const playbackStartP50Ms =
                playbackSamples.length === measured.runs.length
                    ? window.KokoroBenchmark.nearestRank(playbackSamples, 50)
                    : null;
            let cancelJoinP50Ms = null;
            if (isEnglishMeasurement) {
                const cancelJoins = await measureCancelJoin(
                    engine, () => engine.synthesize(text));
                cancelJoinP50Ms = window.KokoroBenchmark.nearestRank(
                    cancelJoins, 50);
            }
            const metrics = {
                ...window.KokoroBenchmark.summarizeRuns(measured.runs),
                coldPrepMs,
                playbackStartP50Ms,
                cancelJoinP50Ms,
            };
            const previous = lastAudioUrl.get(entry.key);
            if (previous) URL.revokeObjectURL(previous);
            const audioUrl = URL.createObjectURL(
                pcmToWavBlob(measured.audio.samples, measured.audio.sampleRateHz));
            lastAudioUrl.set(entry.key, audioUrl);
            ui.audio.src = audioUrl;
            ui.audio.hidden = false;
            setMessage(ui.status,
                formatLocalBenchmarkStatus(entry, metrics, isEnglishMeasurement, english));
            await approveTestedBackend(entry, ui, validationKey, englishReady);
            if (isEnglishMeasurement) {
                rememberSharedEnglishResult(entry, metrics, text, sampleEpoch);
            }

        }, { mode: 'shared' });
    } catch (error) {
        setMessage(ui.status, 'Actual inference failed: ' + String(error.message || error));
    } finally {
        // Retain only the measured audio Blob and summary, not the full
        // WASM model/runtime. A second provider can then be benchmarked in
        // this same page without keeping both engines resident in memory.
        // Removing the mapping before close also prevents reuse after failure.
        const engine = engineByKey.get(entry.key);
        if (engine) {
            engineByKey.delete(entry.key);
            try {
                await engine.close();
            } catch (error) {
                setMessage(ui.status, ui.status.textContent +
                    ' Runtime release failed: ' + String(error.message || error));
            }
        }
        finishModelOperation(entry, ui);
        ui.test.disabled = false;
        ui.remove.disabled = priorRemoveDisabled;
        ui.verify.disabled = priorVerifyDisabled;
    }
}

async function invalidateRuntimeFor(entry) {
    forgetSharedEnglishResult(entry);
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
        if (removed || result?.missingAssets > 0) {
            // A missing asset does not increment removedAssets, but any prior
            // timing and validation for that model (or ONNX dictionary) is stale.
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
            ui.choose.disabled = !priorChooseEnabled ||
                removed > 0 || result?.missingAssets > 0 || !state.ready;
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

async function waitServerAudioDuration(audio) {
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA &&
        Number.isFinite(audio.duration) && audio.duration > 0) {
        return audio.duration;
    }
    await new Promise((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => {
            cleanup();
            reject(new Error('Server MP3 failed to decode'));
        };
        const cleanup = () => {
            audio.removeEventListener('loadedmetadata', onReady);
            audio.removeEventListener('error', onError);
        };
        audio.addEventListener('loadedmetadata', onReady, { once: true });
        audio.addEventListener('error', onError, { once: true });
        audio.load();
    });
    if (!(Number.isFinite(audio.duration) && audio.duration > 0)) {
        throw new Error('Server MP3 duration missing');
    }
    return audio.duration;
}

function clearServerFirstBodyByteDataset(status) {
    delete status.dataset.streamingFirstBodyByteMeasured;
    delete status.dataset.firstBodyByteP50Ms;
    delete status.dataset.synthesisP50Ms;
    delete status.dataset.playbackStartP50Ms;
    delete status.dataset.playbackStartMeasured;
    delete status.dataset.playbackStartNotMeasured;
    delete status.dataset.mediasourceProgressiveTtfaMeasured;
    delete status.dataset.mediasourceProgressiveTtfaNotMeasured;
    delete status.dataset.mediasourceProgressiveTtfaUnavailable;
    delete status.dataset.mediasourceProgressiveTtfaP50Ms;
    delete status.dataset.usedMediaSource;
}

/**
 * Page-level streamed fetch for progressive MediaSource TTFA only.
 * Never invents a number: unavailable when MSE/mime/stream cannot run.
 * Progressive-only HTTP/fetch failures map to unavailable (do not fail the
 * whole FastAPI card). Re-checks fastapi selection before POST (like
 * background FETCH_TTS_AUDIO) so local-mode switches never leak text.
 */
async function measureFastApiProgressiveMediaSourceTtfa(
    endpoint, input, voice) {
    const probe = probeMediaSourceProgressiveMp3Support();
    if (!probe.supported) {
        return progressiveTtfaUnavailable({ reason: probe.reason });
    }
    // Per-request gate: user may have switched to a local backend mid-test.
    // Storage read failure must not fail the whole FastAPI card — map to
    // progressive unavailable and keep playable-clip results.
    let selected;
    try {
        selected = await browser.storage.sync.get({ ttsBackend: 'fastapi' });
    } catch (error) {
        return progressiveTtfaUnavailable({
            reason: 'Progressive settings read failed: ' +
                String(error?.message || error),
        });
    }
    if (selected.ttsBackend !== 'fastapi') {
        return progressiveTtfaUnavailable({
            reason: 'FastAPI no longer selected; progressive request skipped',
        });
    }
    const startedAt = performance.now();
    const timeoutMs = DEFAULT_PROGRESSIVE_TTFA_TIMEOUT_MS;
    const abortController = new AbortController();
    // Arm deadline before fetch so hung headers cannot stall the FastAPI card.
    let headerDeadlineTimer = null;
    if (timeoutMs > 0) {
        headerDeadlineTimer = setTimeout(() => {
            try { abortController.abort(); } catch { /* ignore */ }
        }, timeoutMs);
    }
    let response;
    try {
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'kokoro', input, voice,
                    response_format: 'mp3', speed: 1,
                }),
                signal: abortController.signal,
            });
        } catch (error) {
            return progressiveTtfaUnavailable({
                mimeType: probe.mimeType,
                reason: 'Progressive MediaSource fetch failed: ' +
                    String(error?.message || error),
            });
        }
        if (!response.ok) {
            // Streamed bounded preview — do not wait for error-body EOF.
            const errText = await readBoundedResponseText(
                response, undefined, abortController.signal);
            return progressiveTtfaUnavailable({
                mimeType: probe.mimeType,
                reason: 'Progressive MediaSource HTTP ' + response.status +
                    (errText ? ' ' + errText : ''),
            });
        }
        if (!probeMediaSourceProgressiveMp3Support().supported) {
            cancelReadableStreamBody(response.body);
            abortController.abort();
            return progressiveTtfaUnavailable({
                reason: 'MediaSource progressive support lost before measure',
            });
        }
        // Headers can arrive after the deadline while the abort callback is
        // still queued. timeoutMs 0 means "no timeout" inside the measurer —
        // refuse the handoff instead of hanging on a stalled body.
        const remainingMs = timeoutMs - (performance.now() - startedAt);
        if (remainingMs <= 0) {
            cancelReadableStreamBody(response.body);
            abortController.abort();
            return progressiveTtfaUnavailable({
                mimeType: probe.mimeType,
                reason: 'Progressive MediaSource TTFA timed out after ' +
                    timeoutMs + 'ms',
            });
        }
        return measureProgressiveMediaSourceTtfa({
            body: response.body,
            startedAt,
            contentType: response.headers?.get?.('Content-Type') || 'audio/mpeg',
            signal: abortController.signal,
            timeoutMs: remainingMs,
        });
    } finally {
        if (headerDeadlineTimer != null) clearTimeout(headerDeadlineTimer);
    }
}

/**
 * One streamed FastAPI fetch + decode + muted playback start. Callers decide
 * whether the sample is an untimed warm-up or a measured warm run.
 */
async function fetchFastApiPlayableClip(endpoint, input, voice, audio) {
    const wallStarted = performance.now();
    const result = await browser.runtime.sendMessage({
        action: 'FETCH_TTS_AUDIO', backend: 'fastapi',
        endpoint,
        payload: { model: 'kokoro', input, voice,
            response_format: 'mp3', speed: 1 },
    });
    const synthesisMs = performance.now() - wallStarted;
    if (!result?.success || !result.dataUrl) {
        throw new Error(result?.error || 'No MP3 data returned');
    }
    if (!Number.isFinite(result.firstBodyByteMs) ||
        result.firstBodyByteMs < 0) {
        throw new Error(
            'First body byte (TTFB) was not measured ' +
            '(need a streamed response body)');
    }
    // Decode before accepting — a late valid MP3 must not launder earlier
    // non-audio bodies into warm-up success or measured p50.
    audio.src = result.dataUrl;
    audio.hidden = false;
    const durationSec = await waitServerAudioDuration(audio);
    // playingAtMs is captured in the `playing` handler (before cleanup).
    const playingAtMs = await waitServerAudioPlaybackStart(audio);
    // Fetch-start → HTMLAudioElement 'playing' (full download, not MSE TTFA).
    const playbackStartMs = playingAtMs - wallStarted;
    return {
        firstBodyByteMs: result.firstBodyByteMs,
        synthesisMs,
        playbackStartMs,
        audioDurationSec: durationSec,
    };
}

/**
 * Apply progressive MediaSource TTFA dataset + status tail. Never invents p50.
 * @returns {string} progressiveStatusTail
 */
function applyProgressiveMediaSourceTtfaStatus(
    status, progressiveSamples, progressiveUnavailableReason,
    progressiveUsedMediaSource) {
    status.dataset.usedMediaSource = progressiveUsedMediaSource
        ? 'true' : 'false';
    if (progressiveSamples.length === 3) {
        const progressiveTtfaP50Ms = window.KokoroBenchmark.nearestRank(
            progressiveSamples, 50);
        if (!(Number.isFinite(progressiveTtfaP50Ms) &&
            progressiveTtfaP50Ms >= 0)) {
            throw new Error(
                'Progressive MediaSource TTFA p50 was not finite');
        }
        status.dataset.mediasourceProgressiveTtfaMeasured = 'true';
        status.dataset.mediasourceProgressiveTtfaNotMeasured = 'false';
        status.dataset.mediasourceProgressiveTtfaUnavailable = 'false';
        status.dataset.mediasourceProgressiveTtfaP50Ms =
            String(progressiveTtfaP50Ms);
        return 'progressive MediaSource TTFA measured p50: ' +
            progressiveTtfaP50Ms.toFixed(0) + ' ms; ';
    }
    // Fail closed: never invent a progressive TTFA number.
    status.dataset.mediasourceProgressiveTtfaMeasured = 'false';
    status.dataset.mediasourceProgressiveTtfaNotMeasured = 'true';
    status.dataset.mediasourceProgressiveTtfaUnavailable = 'true';
    delete status.dataset.mediasourceProgressiveTtfaP50Ms;
    return 'progressive MediaSource TTFA unavailable' +
        (progressiveUnavailableReason
            ? ' (' + progressiveUnavailableReason + ')'
            : '') +
        '; MediaSource progressive TTFA not measured; ';
}

async function collectFastApiWarmRuns(
    endpoint, input, voice, audio, options = {}) {
    const runs = [];
    const progressiveSamples = [];
    let progressiveUnavailableReason = options.progressiveUnavailableReason ||
        null;
    let progressiveUsedMediaSource = options.progressiveUsedMediaSource === true;
    const measureProgressive = options.measureProgressive !== false;
    for (let n = 0; n < 3; n++) {
        const clip = await fetchFastApiPlayableClip(
            endpoint, input, voice, audio);
        // summarizeRuns' firstAudioMs slot holds first-body-byte samples;
        // UI/export must label them TTFB, never MediaSource streaming TTFA.
        runs.push({
            kind: 'warm',
            firstAudioMs: clip.firstBodyByteMs,
            synthesisMs: clip.synthesisMs,
            playbackStartMs: clip.playbackStartMs,
            audioDurationSec: clip.audioDurationSec,
        });
        if (!measureProgressive) continue;
        const progressive = await measureFastApiProgressiveMediaSourceTtfa(
            endpoint, input, voice);
        if (progressive.usedMediaSource) progressiveUsedMediaSource = true;
        if (progressive.measured && Number.isFinite(progressive.ttfaMs)) {
            progressiveSamples.push(progressive.ttfaMs);
        } else if (progressive.unavailable) {
            progressiveUnavailableReason = progressive.reason ||
                'progressive MediaSource TTFA unavailable';
        }
    }
    return {
        runs, progressiveSamples, progressiveUnavailableReason,
        progressiveUsedMediaSource,
    };
}

async function testFastApi() {
    const button = document.getElementById('testServer');
    const choose = document.getElementById('chooseServer');
    const status = document.getElementById('serverStatus');
    choose.disabled = true;
    button.disabled = true;
    clearServerFirstBodyByteDataset(status);
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
        const audio = document.getElementById('serverAudio');
        // Untimed warm-up absorbs cold FastAPI/model init — same honesty as
        // local ONNX (exclude cold prep from runs labeled warm).
        await fetchFastApiPlayableClip(
            endpoint.href, input, settings.voice, audio);
        // Untimed progressive MSE warm-up (separate stream) so cold MSE init
        // is not blended into measured progressive TTFA samples. Timed samples
        // require warm-up to reach playing before EOF — otherwise skip POSTs.
        const progressiveWarm = await measureFastApiProgressiveMediaSourceTtfa(
            endpoint.href, input, settings.voice);
        const warm = await collectFastApiWarmRuns(
            endpoint.href, input, settings.voice, audio, {
                measureProgressive: progressiveWarm.measured === true,
                progressiveUnavailableReason: progressiveWarm.measured
                    ? null
                    : (progressiveWarm.reason ||
                        'progressive MediaSource warm-up did not reach playing'),
                progressiveUsedMediaSource:
                    progressiveWarm.usedMediaSource === true,
            });
        const metrics = window.KokoroBenchmark.summarizeRuns(warm.runs);
        const playbackStartP50Ms = window.KokoroBenchmark.nearestRank(
            warm.runs.map(r => r.playbackStartMs), 50);
        if (!(Number.isFinite(playbackStartP50Ms) &&
            playbackStartP50Ms >= metrics.synthesisP50Ms)) {
            throw new Error(
                'Playback start p50 must be at/after full-response p50 ' +
                '(post-download HTMLAudioElement start, not MediaSource)');
        }
        status.dataset.streamingFirstBodyByteMeasured = 'true';
        status.dataset.firstBodyByteP50Ms = String(metrics.firstAudioP50Ms);
        status.dataset.synthesisP50Ms = String(metrics.synthesisP50Ms);
        // Survives chooseServer replacing status text with "FastAPI selected."
        status.dataset.playbackStartMeasured = 'true';
        status.dataset.playbackStartP50Ms = String(playbackStartP50Ms);
        const progressiveStatusTail = applyProgressiveMediaSourceTtfaStatus(
            status, warm.progressiveSamples,
            warm.progressiveUnavailableReason,
            warm.progressiveUsedMediaSource);
        setMessage(status,
            'Server returned playable MP3. First body byte (TTFB) p50: ' +
            metrics.firstAudioP50Ms.toFixed(0) +
            ' ms; full response p50: ' +
            metrics.synthesisP50Ms.toFixed(0) +
            ' ms; playback start p50: ' +
            playbackStartP50Ms.toFixed(0) +
            ' ms (HTMLAudioElement after full download; muted; ' +
            'not MediaSource streaming TTFA; ' +
            progressiveStatusTail +
            'after untimed warm-up; ' +
            '3 warm runs). Local backends do not measure first-audio.');
        choose.disabled = false;
    } catch (error) {
        clearServerFirstBodyByteDataset(status);
        setMessage(status, 'Server test failed: ' + String(error.message || error));
    } finally {
        button.disabled = false;
    }
}

function applyLongerSharedEnglishSample() {
    const input = document.getElementById('benchmarkText');
    if (!input) return;
    input.value = LONGER_SHARED_ENGLISH_SAMPLE;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

if (page) {
    document.getElementById('benchmarkText').addEventListener('input', () => {
        // Editing the common sample invalidates every prior comparison,
        // including results from tests that may still be running.
        sharedEnglishEpoch++;
        sharedEnglishResults.clear();
        renderSharedEnglishResults();
    });
    document.getElementById(LONGER_SHARED_ENGLISH_BUTTON_ID)
        ?.addEventListener('click', applyLongerSharedEnglishSample);
    document.getElementById('exportMeasuredResults')?.addEventListener('click', () => {
        void exportMeasuredEnglishResults();
    });
    renderSharedEnglishResults();
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
