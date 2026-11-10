// Live model-backed Chromium MV3 validation. Explicit opt-in and no model weights in git.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
// The extension's .js modules are ESM while package.json is CommonJS for the
// build tool. Copy the pure catalog into a temporary .mjs file for the Node harness.
const catalogFile = path.join(os.tmpdir(), 'kokoro-runtime-model-catalog.mjs');
await writeFile(catalogFile, await readFile(path.resolve('model-catalog.js')));
const { manifestForVariant, dictionaryManifest } = await import(pathToFileURL(catalogFile).href);

if (process.env.KOKORO_LIVE_DOWNLOAD !== '1' || !process.env.PLAYWRIGHT_MODULE_PATH) {
    throw Error('Live model download opt-in and pinned Playwright module path required');
}
// Test a single provider in isolation when diagnosing memory pressure. The
// default still tests both providers and fails if either fails.
const providerFilter = process.env.KOKORO_LIVE_PROVIDER || 'both';
if (!['both', 'onnx', 'mediapipe'].includes(providerFilter)) {
    throw Error('KOKORO_LIVE_PROVIDER must be both, onnx, or mediapipe');
}
const variants = [
    ...(providerFilter === 'mediapipe' ? [] :
        [dictionaryManifest(), manifestForVariant('onnx', 'q8')]),
    ...(providerFilter === 'onnx' ? [] : [manifestForVariant('mediapipe', 'cpu')]),
];
const sourceDir = path.join(os.tmpdir(), 'kokoro-live-models');
const resultsDir = path.resolve('dist/runtime-acceptance');
await mkdir(sourceDir, { recursive: true });
await mkdir(resultsDir, { recursive: true });
const local = new Map();
const byFilename = new Map();
for (const manifest of variants) for (const asset of manifest.assets) {
    const expected = Buffer.from(asset.integrity.slice(7), 'base64').toString('hex');
    if (local.has(expected)) continue;
    const file = path.join(sourceDir, expected);
    async function matchesPinnedAsset() {
        let info;
        try { info = await stat(file); } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
        if (!info.isFile() || info.size !== asset.bytes) return false;
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        return hash.digest('hex') === expected;
    }
    // Local reruns may reuse the model, but only after verifying every byte
    // against the pinned manifest; partial/altered files are redownloaded.
    if (!(await matchesPinnedAsset())) {
        const response = await fetch(asset.url);
        if (!response.ok || !response.body) throw Error('Cannot fetch official model: ' + asset.path);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
        if (!(await matchesPinnedAsset())) {
            throw Error('Model byte count or SHA-256 mismatch: ' + asset.path);
        }
        console.log('Downloaded and verified official model data', asset.path, asset.bytes);
    } else {
        console.log('Reused checksum-verified local model data', asset.path, asset.bytes);
    }
    local.set(expected, file);
    byFilename.set(path.posix.basename(asset.path), file);
    // The test fixture indexes the exact public model filenames as well as hashes.
}
let extensionOrigin = null;
// A random per-run URL token authenticates Chrome requests, including MV3 GET
// requests for which Chrome intentionally omits the Origin header.
const transferToken = randomBytes(32).toString('hex');
const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    // The clean-path token makes the final URL component the unmodified
    // .litertlm filename. Some SDKs select the model decoder by path suffix.
    const authenticatedPrefix = '/' + transferToken + '/';
    const cleanPath = url.pathname.startsWith(authenticatedPrefix);
    const tokenValid = cleanPath || url.searchParams.get('token') === transferToken;
    if (!extensionOrigin || (req.headers.origin && req.headers.origin !== extensionOrigin) ||
        !tokenValid || req.method !== 'GET') {
        res.writeHead(403);
        res.end();
        return;
    }
    const name = cleanPath ? url.pathname.slice(authenticatedPrefix.length) : url.pathname.slice(1);
    const file = local.get(name) || byFilename.get(name);
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
        'Access-Control-Allow-Origin': extensionOrigin,
        'Vary': 'Origin',
        'Content-Type': 'application/octet-stream',
    });
    createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
    const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
    const extension = path.resolve('dist/chrome');
    context = await chromium.launchPersistentContext(path.join(sourceDir, 'profile'), {
        channel: 'chromium', headless: true,
        args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
    const extensionId = new URL(worker.url()).hostname;
    extensionOrigin = 'chrome-extension://' + extensionId;
    const preflightPage = await context.newPage();
    const errors = [];
    preflightPage.on('pageerror', error => errors.push(String(error)));
    await preflightPage.goto('chrome-extension://' + extensionId + '/benchmark.html');
    await preflightPage.locator('#runCheck').click();
    // Clicking only awaits DOM dispatch, not the async capability inspection.
    // Wait until the extension's result is complete before parsing JSON.
    await preflightPage.waitForFunction(() => {
        const run = document.getElementById('runCheck');
        const status = document.getElementById('status')?.textContent || '';
        return !run?.disabled && (/preflight complete/i.test(status) || /preflight failed/i.test(status));
    }, null, { timeout: 60000 });
    const preflightStatus = await preflightPage.locator('#status').textContent();
    if (/preflight failed/i.test(preflightStatus)) {
        throw Error('Chrome extension capability preflight failed: ' + preflightStatus);
    }
    const preflight = JSON.parse(await preflightPage.locator('#report').textContent());
    if (!preflight.wasmCompilation) throw Error('Chrome extension CSP blocks WebAssembly compilation');
    // Exercise the production model-data store against its real pinned HTTPS
    // CMUdict URL. This deliberately does not substitute the local loopback
    // transfer used later for heavyweight model inference acceptance.
    const dictionaryCacheAcceptance = await preflightPage.evaluate(async () => {
        try {
            const [{ ModelDataStore }, { dictionaryManifest }] = await Promise.all([
                import('./model-data-store.js'), import('./model-catalog.js'),
            ]);
            const manifest = dictionaryManifest();
            let networkFetches = 0;
            let reportedBytes = 0;
            const store = new ModelDataStore({
                origin: chrome.runtime.getURL('/'), cacheStorage: caches,
                fetchImpl: (...args) => {
                    networkFetches++;
                    return fetch(...args);
                },
                responseClass: Response, streamClass: TransformStream,
            });
            await store.remove(manifest);
            if ((await store.status(manifest)).ready) {
                throw Error('Dictionary persisted after explicit removal');
            }
            await store.install(manifest, {
                onProgress: ({ completedBytes }) => { reportedBytes = completedBytes; },
            });
            const verified = await store.verifyAndPruneCorrupt(manifest);
            if (!verified.ready || verified.removedAssets !== 0 ||
                reportedBytes !== manifest.assets[0].bytes || networkFetches !== 1) {
                throw Error('Real pinned dictionary CORS/SRI download or SHA-256 verification failed');
            }
            await store.install(manifest);
            if (networkFetches !== 1) {
                throw Error('Checksum-matching retry made an unnecessary network request');
            }
            // Keep verified bytes in extension storage for a real browser
            // process restart. The restart probe will delete/repair/remove them.
            return { success: true, provider: 'dictionary', byteCount: reportedBytes,
                directOfficialHttpsFetches: networkFetches, verifiedSha256: true,
                cachedRetryWithoutFetch: true, retainedForRestart: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    });
    if (!dictionaryCacheAcceptance.success) {
        await writeFile(path.join(resultsDir, 'report.json'), JSON.stringify({
            browser: preflight.browser, dictionaryCacheAcceptance,
        }, null, 2));
        throw Error('Chromium direct dictionary cache acceptance failed: ' +
            dictionaryCacheAcceptance.error);
    }
    // A separate renderer page per model releases ONNX WASM allocations before
    // starting the much larger MediaPipe WASM engine. Keep extension Cache
    // Storage persistent across pages so the test still uses real cached data.
    await preflightPage.close();
    const results = [];
    let browserRestartAcceptance = null;
    let dictionaryUiDownloadAcceptance = null;
    const saveReport = () => writeFile(path.join(resultsDir, 'report.json'), JSON.stringify({
        testedAt: new Date().toISOString(), browser: preflight.browser, preflight,
        dictionaryCacheAcceptance, browserRestartAcceptance,
        dictionaryUiDownloadAcceptance, results,
        providerFilter,
        networkRequirement: 'offline during every local synthesis probe',
        cachePopulation: 'heavy weights preloaded from verified pinned bytes over authenticated loopback; dictionary official HTTPS verified and opt-in Chromium Download/Cancel/Retry UI exercised separately',
        scope: 'Linux Chromium MV3 extension origin; no subjective audio-quality or complete download-manager acceptance',
    }, null, 2));
    for (const manifest of variants) {
        const page = await context.newPage();
        let crashed = false;
        let stage = 'model-cache-population';
        page.on('pageerror', error => errors.push(String(error)));
        page.on('crash', () => { crashed = true; });
        try {
            await page.goto('chrome-extension://' + extensionId + '/benchmark.html');
            await page.evaluate(async ({ manifest, port, transferToken }) => {
            const { ModelDataStore } = await import('./model-data-store.js');
            const store = new ModelDataStore({ origin: chrome.runtime.getURL('/'),
                cacheStorage: caches, fetchImpl: fetch, responseClass: Response, streamClass: TransformStream });
            const cache = await caches.open('kokoro-model-data-v1');
            for (const asset of manifest.assets) {
                const hex = Array.from(Uint8Array.from(atob(asset.integrity.slice(7)), ch => ch.charCodeAt(0)))
                    .map(b => b.toString(16).padStart(2, '0')).join('');
                const downloaded = await fetch('http://127.0.0.1:' + port + '/' + hex + '?token=' + transferToken);
                if (!downloaded.ok || !downloaded.body) throw Error('Local verified model transfer failed');
                await cache.put(store.key(manifest, asset), new Response(downloaded.body, {
                    headers: { 'x-kokoro-integrity': asset.integrity, 'x-kokoro-bytes': String(asset.bytes) },
                }));
            }
            if (!(await store.status(manifest)).ready) throw Error('Verified browser model cache incomplete');
        }, { manifest, port: server.address().port, transferToken });
            if (manifest.provider === 'dictionary') continue; // verified/cache-preloaded; no inference engine
            // Require the cached SDK, WASM, voices, model and dictionary to
            // produce speech with all HTTP(S) requests disabled by Chromium.
            await context.setOffline(true);
            if (!await page.evaluate(() => navigator.onLine === false)) {
                throw Error('Chromium did not enter offline mode before inference');
            }
            stage = 'offline-model-initialization-and-synthesis';
            await page.evaluate(({ provider, variant }) => {
            window.__kokoroProbe = { done: false };
            void (async () => {
                let engine;
                try {
                    const sdk = provider === 'onnx' ? await import('./onnx-provider.js')
                        : await import('./mediapipe-provider.js');
                    engine = provider === 'onnx' ? new sdk.OnnxKokoroProvider({ variant })
                        : new sdk.MediaPipeKokoroProvider({ variant });
                    const start = performance.now();
                    await engine.initialize();
                    const initMs = performance.now() - start;
                    const samples = [];
                    let audio;
                    for (let i = 0; i < 3; i++) {
                        const t = performance.now();
                        audio = provider === 'onnx' ? await engine.synthesizePhonemes('hɛˈloʊ.')
                            : await engine.synthesize('Hello from Kokoro running on this device.');
                        samples.push(performance.now() - t);
                    }
                    let englishText = null;
                    if (provider === 'onnx') {
                        const plain = await engine.synthesize('Hello world.');
                        const textRms = Math.sqrt(plain.samples.reduce(
                            (s, v) => s + v * v, 0) / plain.samples.length);
                        if (!Number.isFinite(textRms) || textRms < 0.0001 ||
                            plain.sampleRateHz !== 24000 || !plain.samples.every(Number.isFinite)) {
                            throw Error('Invalid ONNX English dictionary PCM output');
                        }
                        englishText = { input: 'Hello world.', rms: textRms,
                            durationSec: plain.samples.length / plain.sampleRateHz };
                    }
                    const rms = Math.sqrt(audio.samples.reduce((s, v) => s + v * v, 0) / audio.samples.length);
                    const seconds = audio.samples.length / audio.sampleRateHz;
                    if (!audio.samples.length || !Number.isFinite(rms) || rms < 0.0001 ||
                        seconds < 0.2 || seconds > 30 || !audio.samples.every(Number.isFinite)) {
                        throw Error('Empty, silent or malformed PCM output');
                    }
                    window.__kokoroProbe = { done: true, success: true, provider, variant, initMs,
                        warmSynthesisMs: samples, durationSec: seconds, rms,
                        sampleRateHz: audio.sampleRateHz, englishText };
                } catch (error) {
                    window.__kokoroProbe = { done: true, success: false, error: String(error),
                        stack: String(error.stack || '') };
                } finally { try { await engine?.close(); } catch { /* keep result */ } }
            })();
        }, { provider: manifest.provider, variant: manifest.variant });
        await page.waitForFunction(() => window.__kokoroProbe?.done === true, null, { timeout: 240000 });
        const result = await page.evaluate(() => window.__kokoroProbe);
        // Diagnose whether the upstream task requires the original .litertlm
        // filename instead of a Blob URL, without changing production behavior.
        // This probe has no text/network fallback beyond our authenticated loopback model server.
        if (!result.success && manifest.provider === 'mediapipe') {
            // The existing upstream-model path diagnostics may fetch from the
            // authenticated loopback server. Run them only AFTER the strict
            // offline inference result has already failed; never count them
            // as offline acceptance or silently turn a failure into a pass.
            await context.setOffline(false);
            result.diagnosticsNetworkReenabled = true;
            const diagnostic = await page.evaluate(async ({ port, transferToken }) => {
                let task;
                try {
                    const sdk = await import('./runtimes/mediapipe/audio_bundle.mjs');
                    const files = await sdk.FilesetResolver.forAudioTasks(
                        chrome.runtime.getURL('runtimes/mediapipe/wasm'));
                    const modelAssetPath = 'http://127.0.0.1:' + port + '/' +
                        transferToken + '/kokoro_int8_fp16.litertlm';
                    task = await sdk.TextToSpeech.createFromOptions(files, {
                        baseOptions: { modelAssetPath, delegate: 'CPU' },
                        defaultVoiceId: 'af_heart', speakingRate: 1,
                        cacheDirectory: ':nocache',
                    });
                    const audio = await task.synthesize('Hello from local Kokoro.');
                    return { success: audio.samples instanceof Float32Array,
                        sampleRateHz: audio.sampleRateHz, samples: audio.samples?.length };
                } catch (error) {
                    return { success: false, error: String(error) };
                } finally { try { await task?.close(); } catch { /* diagnostics only */ } }
            }, { port: server.address().port, transferToken });
            result.originalFilenameDiagnostic = diagnostic;
            console.log('MEDIAPIPE EXACT .litertlm FILENAME DIAGNOSTIC', diagnostic);
            // Google AI Edge documents modelAssetBuffer for cached model data.
            // Independently test that path before claiming the .litertlm
            // model is incompatible with this packaged MediaPipe SDK.
            const bufferedDiagnostic = await page.evaluate(async ({ manifest }) => {
                let task;
                try {
                    const { ModelDataStore } = await import('./model-data-store.js');
                    const store = new ModelDataStore({
                        origin: chrome.runtime.getURL('/'), cacheStorage: caches,
                        fetchImpl: fetch, responseClass: Response, streamClass: TransformStream,
                    });
                    const cache = await caches.open('kokoro-model-data-v1');
                    const cached = await cache.match(store.key(manifest, manifest.assets[0]));
                    if (!store.isCurrent(cached, manifest.assets[0])) throw Error('Model data missing from cache');
                    const modelAssetBuffer = new Uint8Array(await cached.arrayBuffer());
                    const sdk = await import('./runtimes/mediapipe/audio_bundle.mjs');
                    const files = await sdk.FilesetResolver.forAudioTasks(
                        chrome.runtime.getURL('runtimes/mediapipe/wasm'));
                    task = await sdk.TextToSpeech.createFromOptions(files, {
                        baseOptions: { modelAssetBuffer, delegate: 'CPU' },
                        defaultVoiceId: 'af_heart', speakingRate: 1,
                        cacheDirectory: ':nocache',
                    });
                    const audio = await task.synthesize('Hello from local Kokoro.');
                    return { success: audio.samples instanceof Float32Array,
                        sampleRateHz: audio.sampleRateHz, samples: audio.samples?.length };
                } catch (error) {
                    return { success: false, error: String(error) };
                } finally { try { await task?.close(); } catch { /* diagnostics only */ } }
            }, { manifest });
            result.bufferedModelDiagnostic = bufferedDiagnostic;
            console.log('MEDIAPIPE MODEL BUFFER DIAGNOSTIC', bufferedDiagnostic);
        }
            console.log(result.success ? 'REAL MODEL INFERENCE' : 'MODEL INFERENCE FAILURE', result);
            results.push({ provider: manifest.provider, variant: manifest.variant,
                offlineAttempted: true, offlineInference: result.success === true, ...result });
            await saveReport();
        } catch (error) {
            const failure = { provider: manifest.provider, variant: manifest.variant,
                success: false, crashed, stage, error: String(error) };
            results.push(failure);
            await saveReport();
            console.error('MODEL VALIDATION ABORTED', failure);
            throw error;
        } finally {
            // Restore network only for the next verified local model transfer.
            // Each provider's acceptance itself must finish entirely offline.
            await context.setOffline(false);
            if (!page.isClosed()) await page.close();
        }
    }
    if (errors.length) throw Error('Extension errors: ' + errors.join('; '));
    if (results.some(result => !result.success)) {
        throw Error('One or more actual model integrations failed: see attached report.json');
    }

    // The persistent Chromium profile is reused across an actual browser
    // process shutdown/startup. No network model re-download may be needed.
    await context.close();
    context = null;
    context = await chromium.launchPersistentContext(path.join(sourceDir, 'profile'), {
        channel: 'chromium', headless: true,
        args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
    });
    const restartedWorker = context.serviceWorkers()[0] ||
        await context.waitForEvent('serviceworker', { timeout: 30000 });
    const restartedId = new URL(restartedWorker.url()).hostname;
    if (restartedId !== extensionId) {
        throw Error('Chromium extension identity changed across browser restart');
    }
    const reopened = await context.newPage();
    reopened.on('pageerror', error => errors.push(String(error)));
    try {
        await reopened.goto('chrome-extension://' + restartedId + '/benchmark.html');
        // Prove the UI has observed the dictionary before deliberate eviction.
        await reopened.waitForFunction(() => {
            const row = document.querySelector('[data-variant="dictionary-english"]');
            return row?.querySelector('.model-status')?.textContent?.includes('Installed') &&
                row?.querySelector('.model-remove')?.disabled === false;
        }, null, { timeout: 30000 });
        await context.setOffline(true);
        const persisted = await reopened.evaluate(async manifests => {
            const [{ ModelDataStore }, { dictionaryManifest }] = await Promise.all([
                import('./model-data-store.js'), import('./model-catalog.js'),
            ]);
            if (navigator.onLine !== false) throw Error('Browser is not offline after restart');
            const store = new ModelDataStore({
                origin: chrome.runtime.getURL('/'), cacheStorage: caches,
                fetchImpl: () => { throw Error('Unexpected fetch while testing persisted cache'); },
                responseClass: Response, streamClass: TransformStream,
            });
            for (const m of manifests) {
                // Metadata-only: does not claim full weight SHA-256 validation.
                if (!(await store.status(m)).ready) {
                    throw Error('Model cache missing after Chromium restart: ' +
                        m.provider + '/' + m.variant);
                }
            }
            const dictionary = dictionaryManifest();
            const actual = await store.verifyAndPruneCorrupt(dictionary);
            if (!actual.ready || actual.removedAssets || actual.missingAssets) {
                throw Error('Dictionary failed offline SHA-256 verification after restart');
            }
            const cache = await caches.open('kokoro-model-data-v1');
            if (!await cache.delete(store.key(dictionary, dictionary.assets[0]))) {
                throw Error('Unable to simulate dictionary cache eviction');
            }
            if ((await store.status(dictionary)).ready) {
                throw Error('Evicted dictionary still reported installed');
            }
            return { modelStatusRetained: manifests.length, dictionarySha256Retained: true,
                simulatedEvictionDetected: true };
        }, variants);
        // Recheck uses an eviction-specific message for previously ready data.
        const dictionaryRow = reopened.locator('[data-variant="dictionary-english"]');
        const recheck = reopened.locator('#refreshModelCache');
        await recheck.click();
        await reopened.waitForFunction(() => {
            const row = document.querySelector('[data-variant="dictionary-english"]');
            return row?.querySelector('.model-status')?.textContent
                ?.includes('Cached model data is missing') &&
                row?.querySelector('.model-remove')?.disabled === true &&
                row?.querySelector('.model-download')?.disabled === false;
        }, null, { timeout: 30000 });
        // Restore network for an explicitly requested dictionary repair only.
        await context.setOffline(false);
        const repaired = await reopened.evaluate(async () => {
            const [{ ModelDataStore }, { dictionaryManifest }] = await Promise.all([
                import('./model-data-store.js'), import('./model-catalog.js'),
            ]);
            const manifest = dictionaryManifest();
            let fetches = 0;
            const store = new ModelDataStore({
                origin: chrome.runtime.getURL('/'), cacheStorage: caches,
                fetchImpl: (...args) => { fetches++; return fetch(...args); },
                responseClass: Response, streamClass: TransformStream,
            });
            if ((await store.status(manifest)).ready || fetches) {
                throw Error('Eviction unexpectedly repaired itself');
            }
            await store.install(manifest); // Only the harness explicitly requests repair.
            const verified = await store.verifyAndPruneCorrupt(manifest);
            if (fetches !== 1 || !verified.ready || verified.removedAssets) {
                throw Error('Explicit post-eviction repair did not restore pinned bytes');
            }
            // The real model-manager Remove button is exercised below.
            return { explicitRepairFetches: fetches, repairedSha256: true };
        });
        if (errors.length) {
            throw Error('Extension page errors after restart: ' + errors.join('; '));
        }
        // Instrument the actual window.fetch which cacheStore() binds inside
        // model-manager Recheck and Remove handlers, after explicit repair.
        await reopened.evaluate(() => {
            const originalFetch = globalThis.fetch.bind(globalThis);
            globalThis.__modelManagerAssetFetches = 0;
            globalThis.fetch = (...args) => {
                const url = String(args[0]?.url || args[0]);
                if (url.startsWith('https://huggingface.co/') ||
                    url.startsWith('https://raw.githubusercontent.com/')) {
                    globalThis.__modelManagerAssetFetches++;
                    throw Error('Unexpected model fetch by manager UI');
                }
                return originalFetch(...args);
            };
        });
        // This must transition from Not installed to Installed via Recheck.
        await recheck.click();
        await reopened.waitForFunction(() => {
            const row = document.querySelector('[data-variant="dictionary-english"]');
            return row?.querySelector('.model-status')?.textContent?.includes('Installed') &&
                row?.querySelector('.model-remove')?.disabled === false;
        }, null, { timeout: 30000 });
        await dictionaryRow.locator('.model-remove').click();
        await reopened.waitForFunction(() => {
            const row = document.querySelector('[data-variant="dictionary-english"]');
            return row?.querySelector('.model-status')?.textContent?.includes('Not installed') &&
                row?.querySelector('.model-remove')?.disabled === true &&
                row?.querySelector('.model-download')?.disabled === false;
        }, null, { timeout: 30000 });
        const afterUiRemove = await reopened.evaluate(async () => {
            const [{ ModelDataStore }, { dictionaryManifest }] = await Promise.all([
                import('./model-data-store.js'), import('./model-catalog.js'),
            ]);
            const store = new ModelDataStore({
                origin: chrome.runtime.getURL('/'), cacheStorage: caches,
                fetchImpl: () => { throw Error('Removal unexpectedly fetched model data'); },
                responseClass: Response, streamClass: TransformStream,
            });
            return {
                ...(await store.status(dictionaryManifest())),
                pageModelFetches: globalThis.__modelManagerAssetFetches,
            };
        });
        if (afterUiRemove.ready || afterUiRemove.storedBytes !== 0 ||
            afterUiRemove.pageModelFetches !== 0) {
            throw Error('Manager cache or fetch assertion failed: ' + JSON.stringify(afterUiRemove));
        }
        if (errors.length) {
            throw Error('Extension page errors after restart: ' + errors.join('; '));
        }
        browserRestartAcceptance = { success: true, browserProcessRestarted: true,
            networkDisabledDuringPersistenceChecks: true,
            modelManagerRecheckClicked: true, modelManagerRemoveClicked: true,
            uiEvictionObservedBeforeRepair: true, noUiModelFetches: true,
            uiRemovalVerifiedInCache: true, ...persisted, ...repaired };
        await saveReport();

        // Download/Cancel/Retry acceptance: use real packaged extension buttons
        // and a real pinned dictionary, not the model manager's mocked API.
        // A deliberately stalled fetch makes cancellation reproducible.
        try {
            await reopened.reload(); // Drop the earlier no-fetch guard.
            await reopened.waitForFunction(() => {
                const row = document.querySelector('[data-variant="dictionary-english"]');
                return row?.querySelector('.model-status')?.textContent?.includes('Not installed') &&
                    row?.querySelector('.model-download')?.disabled === false;
            }, null, { timeout: 30000 });
            const downloadButton = reopened.locator(
                '[data-variant="dictionary-english"] .model-download');
            await reopened.evaluate(() => {
                const original = globalThis.fetch.bind(globalThis);
                globalThis.__dictionaryUiOriginalFetch = original;
                globalThis.__dictionaryUiCancelledFetches = 0;
                globalThis.fetch = (input, options) => {
                    const url = String(input?.url || input);
                    if (url.includes('/cmudict.dict')) {
                        globalThis.__dictionaryUiCancelledFetches++;
                        return new Promise((resolve, reject) => {
                            if (options?.signal?.aborted) {
                                reject(new DOMException('Download aborted', 'AbortError'));
                            } else {
                                options?.signal?.addEventListener('abort', () => {
                                    reject(new DOMException('Download aborted', 'AbortError'));
                                }, { once: true });
                            }
                        });
                    }
                    return original(input, options);
                };
            });
            await downloadButton.click();
            await reopened.waitForFunction(() => {
                const row = document.querySelector('[data-variant="dictionary-english"]');
                return row?.querySelector('.model-download')?.textContent ===
                    'Cancel download' && row?.querySelector('.model-download')?.disabled === false;
            }, null, { timeout: 30000 });
            await downloadButton.click();
            await reopened.waitForFunction(() => {
                const row = document.querySelector('[data-variant="dictionary-english"]');
                return row?.querySelector('.model-status')?.textContent?.includes('Download cancelled') &&
                    row?.querySelector('.model-download')?.textContent?.startsWith('Download') &&
                    row?.querySelector('.model-download')?.disabled === false &&
                    row?.querySelector('.model-progress')?.hidden === true;
            }, null, { timeout: 30000 });
            const cancelled = await reopened.evaluate(async () => {
                const [{ ModelDataStore }, { dictionaryManifest }] = await Promise.all([
                    import('./model-data-store.js'), import('./model-catalog.js'),
                ]);
                const store = new ModelDataStore({
                    origin: chrome.runtime.getURL('/'), cacheStorage: caches,
                    fetchImpl: () => { throw Error('Cancelled download unexpectedly fetched'); },
                    responseClass: Response, streamClass: TransformStream,
                });
                return { ...(await store.status(dictionaryManifest())),
                    fetches: globalThis.__dictionaryUiCancelledFetches };
            });
            if (cancelled.ready || cancelled.storedBytes !== 0 || cancelled.fetches !== 1) {
                throw Error('UI cancellation left data or did not exercise stalled fetch: ' +
                    JSON.stringify(cancelled));
            }
            await reopened.evaluate(() => {
                const original = globalThis.__dictionaryUiOriginalFetch;
                if (typeof original !== 'function') throw Error('Missing native fetch');
                globalThis.__dictionaryUiRealFetches = 0;
                globalThis.fetch = (input, options) => {
                    const url = String(input?.url || input);
                    if (url.includes('/cmudict.dict')) globalThis.__dictionaryUiRealFetches++;
                    return original(input, options);
                };
            });
            await downloadButton.click(); // Explicit retry through user-facing UI.
            await reopened.waitForFunction(() => {
                const row = document.querySelector('[data-variant="dictionary-english"]');
                return row?.querySelector('.model-status')?.textContent?.includes('Installed') &&
                    row?.querySelector('.model-remove')?.disabled === false &&
                    row?.querySelector('.model-progress')?.value === 100;
            }, null, { timeout: 120000 });
            const installed = await reopened.evaluate(async () => {
                const [{ ModelDataStore }, { dictionaryManifest }] = await Promise.all([
                    import('./model-data-store.js'), import('./model-catalog.js'),
                ]);
                const manifest = dictionaryManifest();
                const store = new ModelDataStore({
                    origin: chrome.runtime.getURL('/'), cacheStorage: caches,
                    fetchImpl: () => { throw Error('Verification unexpectedly downloaded'); },
                    responseClass: Response, streamClass: TransformStream,
                });
                const status = await store.status(manifest);
                const verified = await store.verifyAndPruneCorrupt(manifest);
                const permission = await chrome.permissions.contains({
                    origins: [new URL(manifest.assets[0].url).origin + '/*'],
                });
                return { status, verified, permission,
                    actualHostFetches: globalThis.__dictionaryUiRealFetches };
            });
            if (!installed.permission || installed.actualHostFetches !== 1 ||
                !installed.status.ready ||
                installed.status.storedBytes !== installed.status.totalBytes ||
                !installed.verified.ready || installed.verified.removedAssets !== 0) {
                throw Error('UI retry official HTTPS/permission/SHA-256 failed: ' +
                    JSON.stringify(installed));
            }
            await reopened.locator(
                '[data-variant="dictionary-english"] .model-remove').click();
            await reopened.waitForFunction(() => {
                const row = document.querySelector('[data-variant="dictionary-english"]');
                return row?.querySelector('.model-status')?.textContent?.includes('Not installed') &&
                    row?.querySelector('.model-remove')?.disabled === true;
            }, null, { timeout: 30000 });
            const afterRemoval = await reopened.evaluate(async () => {
                const [{ ModelDataStore }, { dictionaryManifest }] = await Promise.all([
                    import('./model-data-store.js'), import('./model-catalog.js'),
                ]);
                const store = new ModelDataStore({
                    origin: chrome.runtime.getURL('/'), cacheStorage: caches,
                    fetchImpl: () => { throw Error('Unexpected network during removal'); },
                    responseClass: Response, streamClass: TransformStream,
                });
                return store.status(dictionaryManifest());
            });
            if (afterRemoval.ready || afterRemoval.storedBytes !== 0 ||
                errors.length) throw Error('Dictionary UI cleanup failed: ' +
                    JSON.stringify({ afterRemoval, errors }));
            dictionaryUiDownloadAcceptance = {
                success: true, browser: 'chromium',
                cancelledStalledDownload: true, cacheEmptyAfterCancel: true,
                realOfficialHttpsRetryFetches: installed.actualHostFetches,
                requestedNarrowHostPermission: installed.permission,
                fullPinnedBytes: installed.status.totalBytes,
                sha256VerifiedAfterUiRetry: true,
                uiProgressReached100: true, uiRemoveClearedCache: true,
            };
            await saveReport();
        } catch (error) {
            dictionaryUiDownloadAcceptance = { success: false, error: String(error) };
            await saveReport();
            throw error;
        }

    } catch (error) {
        browserRestartAcceptance = { success: false, browserProcessRestarted: true,
            error: String(error) };
        await saveReport();
        throw error;
    } finally {
        await context.setOffline(false);
        if (!reopened.isClosed()) await reopened.close();
    }
} finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
}
