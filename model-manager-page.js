// Extension-owned local model manager and *real* opt-in test harness.
// No model fetch occurs when this page loads, and local test inputs stay here.
import { listModelVariants, manifestForVariant } from './model-catalog.js';
import { ModelDataStore, formatModelSize } from './model-data-store.js';
import { MediaPipeKokoroProvider } from './mediapipe-provider.js';
import { OnnxKokoroProvider } from './onnx-provider.js';
import { pcmToWavBlob } from './pcm-wav.js';

const page = document.getElementById('modelManager');
const variants = listModelVariants();
const engineByKey = new Map();
const inFlightDownloads = new Map();
const lastAudioUrl = new Map();

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
    const actions = document.createElement('div');
    actions.className = 'model-actions';
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = 'Download ' + formatModelSize(entry.totalBytes);
    download.className = 'model-download';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.className = 'model-remove';
    const test = document.createElement('button');
    test.type = 'button';
    test.textContent = 'Test synthesized audio (3 runs)';
    test.className = 'model-test';
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.textContent = 'Use this backend';
    choose.className = 'model-choose';
    choose.disabled = true;
    actions.append(download, remove, test, choose);
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.hidden = true;
    row.append(title, status, actions, audio);
    return { row, status, download, remove, test, choose, audio };
}

async function refresh(entry, ui) {
    const state = await cacheStore().status(manifestForVariant(entry.provider, entry.variant));
    setMessage(ui.status, displayModelStatus(entry, state.ready, state.totalBytes));
    ui.test.disabled = !state.ready;
    ui.remove.disabled = !state.storedBytes;
    ui.download.disabled = state.ready;
    return state;
}

async function doDownload(entry, ui) {
    const running = inFlightDownloads.get(entry.key);
    if (running) {
        running.abort();
        return;
    }
    // Firefox and Chrome require request() in the user-gesture stack.
    const permissionPromise = browser.permissions.request({
        origins: ['https://huggingface.co/*'],
    });
    ui.download.disabled = true;
    const allowed = await permissionPromise;
    if (!allowed) {
        setMessage(ui.status, 'Official Hugging Face model host permission was denied.');
        ui.download.disabled = false;
        return;
    }
    const controller = new AbortController();
    inFlightDownloads.set(entry.key, controller);
    ui.download.disabled = false;
    ui.download.textContent = 'Cancel download';
    let downloadError = null;
    try {
        await cacheStore().install(manifestForVariant(entry.provider, entry.variant), {
            signal: controller.signal,
            onProgress: ({ completedBytes, totalBytes }) => {
                setMessage(ui.status, 'Verified ' + formatModelSize(completedBytes) + ' / ' +
                    formatModelSize(totalBytes) + ' (integrity checking may buffer progress)');
            },
        });
    } catch (error) {
        downloadError = 'Download failed: ' + String(error.message || error);
    } finally {
        inFlightDownloads.delete(entry.key);
        ui.download.textContent = 'Download ' + formatModelSize(entry.totalBytes);
        ui.download.disabled = false;
        try {
            await refresh(entry, ui);
        } catch (error) {
            if (!downloadError) downloadError = 'Cannot inspect model cache: ' + String(error.message || error);
        }
        // The model status refresh must not erase the actual download failure.
        if (downloadError) setMessage(ui.status, downloadError);
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
    ui.test.disabled = true;
    ui.choose.disabled = true;
    setMessage(ui.status, 'Loading locally packaged runtime and cached model…');
    try {
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
            '. Streaming time-to-first-audio was not measured. Listen before choosing.');
        // The ONNX probe only accepts IPA, not plain text, so it cannot yet serve
        // article/EPUB requests. Never offer it as a functioning text backend.
        if (entry.provider === 'mediapipe') ui.choose.disabled = false;
    } catch (error) {
        setMessage(ui.status, 'Actual inference failed: ' + String(error.message || error));
    } finally {
        ui.test.disabled = false;
    }
}

function registerModel(entry) {
    const ui = createModelRow(entry);
    page.appendChild(ui.row);
    ui.download.addEventListener('click', () => {
        void doDownload(entry, ui);
    });
    ui.remove.addEventListener('click', async () => {
        ui.remove.disabled = true;
        try {
            const engine = engineByKey.get(entry.key);
            if (engine) {
                await engine.close();
                engineByKey.delete(entry.key);
            }
            await cacheStore().remove(manifestForVariant(entry.provider, entry.variant));
        } catch (error) {
            setMessage(ui.status, 'Removal failed: ' + String(error.message || error));
        }
        await refresh(entry, ui);
        ui.choose.disabled = true;
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
