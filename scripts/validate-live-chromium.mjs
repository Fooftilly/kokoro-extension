// Live model-backed Chromium MV3 validation. Explicit opt-in and no model weights in git.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const { manifestForVariant } = await import(pathToFileURL(catalogFile).href);

if (process.env.KOKORO_LIVE_DOWNLOAD !== '1' || !process.env.PLAYWRIGHT_MODULE_PATH) {
    throw Error('Live model download opt-in and pinned Playwright module path required');
}
const variants = [manifestForVariant('onnx', 'q8'), manifestForVariant('mediapipe', 'cpu')];
const sourceDir = path.join(os.tmpdir(), 'kokoro-live-models');
const resultsDir = path.resolve('dist/runtime-acceptance');
await mkdir(sourceDir, { recursive: true });
await mkdir(resultsDir, { recursive: true });
const local = new Map();
const byFilename = new Map();
for (const manifest of variants) for (const asset of manifest.assets) {
    const expected = Buffer.from(asset.integrity.slice(7), 'base64').toString('hex');
    if (local.has(expected)) continue;
    const response = await fetch(asset.url);
    if (!response.ok || !response.body) throw Error('Cannot fetch official model: ' + asset.path);
    const file = path.join(sourceDir, expected);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
    const hash = createHash('sha256');
    let length = 0;
    for await (const chunk of createReadStream(file)) { length += chunk.length; hash.update(chunk); }
    if (length !== asset.bytes || hash.digest('hex') !== expected) {
        throw Error('Model byte count or SHA-256 mismatch: ' + asset.path);
    }
    local.set(expected, file);
    byFilename.set(path.posix.basename(asset.path), file);
    console.log('Verified official model data', asset.path, length);
}
let extensionOrigin = null;
// A random per-run URL token authenticates Chrome requests, including MV3 GET
// requests for which Chrome intentionally omits the Origin header.
const transferToken = randomBytes(32).toString('hex');
const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!extensionOrigin || (req.headers.origin && req.headers.origin !== extensionOrigin) ||
        url.searchParams.get('token') !== transferToken || req.method !== 'GET') {
        res.writeHead(403);
        res.end();
        return;
    }
    const file = local.get(url.pathname.slice(1)) || byFilename.get(url.pathname.slice(1));
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
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('chrome-extension://' + extensionId + '/benchmark.html');
    await page.locator('#runCheck').click();
    // Clicking only awaits DOM dispatch, not the async capability inspection.
    // Wait until the extension's result is complete before parsing JSON.
    await page.waitForFunction(() => {
        const run = document.getElementById('runCheck');
        const status = document.getElementById('status')?.textContent || '';
        return !run?.disabled && (/preflight complete/i.test(status) || /preflight failed/i.test(status));
    }, null, { timeout: 60000 });
    const preflightStatus = await page.locator('#status').textContent();
    if (/preflight failed/i.test(preflightStatus)) {
        throw Error('Chrome extension capability preflight failed: ' + preflightStatus);
    }
    const preflight = JSON.parse(await page.locator('#report').textContent());
    if (!preflight.wasmCompilation) throw Error('Chrome extension CSP blocks WebAssembly compilation');
    const results = [];
    for (const manifest of variants) {
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
                    const rms = Math.sqrt(audio.samples.reduce((s, v) => s + v * v, 0) / audio.samples.length);
                    const seconds = audio.samples.length / audio.sampleRateHz;
                    if (!audio.samples.length || !Number.isFinite(rms) || rms < 0.0001 ||
                        seconds < 0.2 || seconds > 30 || !audio.samples.every(Number.isFinite)) {
                        throw Error('Empty, silent or malformed PCM output');
                    }
                    window.__kokoroProbe = { done: true, success: true, provider, variant, initMs,
                        warmSynthesisMs: samples, durationSec: seconds, rms, sampleRateHz: audio.sampleRateHz };
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
            const diagnostic = await page.evaluate(async ({ port, transferToken }) => {
                let task;
                try {
                    const sdk = await import('./runtimes/mediapipe/audio_bundle.mjs');
                    const files = await sdk.FilesetResolver.forAudioTasks(
                        chrome.runtime.getURL('runtimes/mediapipe/wasm'));
                    const modelAssetPath = 'http://127.0.0.1:' + port +
                        '/kokoro_int8_fp16.litertlm?token=' + transferToken;
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
            console.log('MEDIAPIPE ORIGINAL FILE NAME DIAGNOSTIC', diagnostic);
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
        results.push({ provider: manifest.provider, variant: manifest.variant, ...result });
        await writeFile(path.join(resultsDir, 'report.json'), JSON.stringify({
            testedAt: new Date().toISOString(), browser: preflight.browser, preflight, results,
            scope: 'Linux Chrome MV3 extension origin; Firefox and audible quality still require separate acceptance',
        }, null, 2));
    }
    if (errors.length) throw Error('Extension errors: ' + errors.join('; '));
    if (results.some(result => !result.success)) {
        throw Error('One or more actual model integrations failed: see attached report.json');
    }
} finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
}
