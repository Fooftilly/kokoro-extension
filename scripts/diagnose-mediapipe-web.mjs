// Compare the official MediaPipe WASM task outside MV3 with identical packaged
// SDK assets and the pinned model. No model or executable downloads.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.PLAYWRIGHT_MODULE_PATH) {
    throw Error('Set PLAYWRIGHT_MODULE_PATH to the pinned Playwright index.mjs');
}
const catalog = await readFile(path.resolve('model-catalog.js'));
const { manifestForVariant } = await import('data:text/javascript;base64,' + catalog.toString('base64'));
const manifest = manifestForVariant('mediapipe', 'cpu');
const asset = manifest.assets[0];
const digest = Buffer.from(asset.integrity.slice('sha256-'.length), 'base64').toString('hex');
const modelFile = path.resolve(process.env.KOKORO_MEDIAPIPE_MODEL ||
    path.join(os.tmpdir(), 'kokoro-live-models', digest));
const runtime = path.resolve('dist/chrome/runtimes/mediapipe');

async function verifyModel() {
    const info = await stat(modelFile);
    if (!info.isFile() || info.size !== asset.bytes) throw Error('Local model size differs from pinned catalog');
    const hash = createHash('sha256');
    for await (const part of createReadStream(modelFile)) hash.update(part);
    if (hash.digest('hex') !== digest) throw Error('Local model SHA-256 mismatch');
}
await verifyModel();
await stat(path.join(runtime, 'audio_bundle.mjs'));
await stat(path.join(runtime, 'wasm', 'audio_wasm_internal.wasm'));
console.log('Verified pinned local model', asset.path, asset.bytes);

// Only the pinned model and packaged SDK files are served, over loopback.
const server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><html><body>Isolated MediaPipe TTS diagnostic</body></html>');
        return;
    }
    let file;
    if (pathname === '/models/' + asset.path) file = modelFile;
    else if (pathname === '/sdk/audio_bundle.mjs') file = path.join(runtime, 'audio_bundle.mjs');
    else if (pathname.startsWith('/sdk/wasm/')) {
        const name = pathname.slice('/sdk/wasm/'.length);
        if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { res.writeHead(404); res.end(); return; }
        file = path.join(runtime, 'wasm', name);
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
        'Content-Type': pathname.endsWith('.mjs') || pathname.endsWith('.js') ? 'text/javascript' :
            pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
        'Cache-Control': 'no-store',
    });
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const reportFile = path.resolve('dist/runtime-acceptance/mediapipe-plain-web.json');
let browser;
let result = { success: false, scenario: 'plain localhost web origin',
    modelSha256: digest, runtime: '@mediapipe/tasks-audio packaged in dist/chrome', browser: null };
try {
    const { chromium } = await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(origin);
    result.browser = await page.evaluate(() => navigator.userAgent);
    await page.evaluate((name) => {
        window.__mediaPipeWebProbe = { done: false };
        void (async () => {
            let task;
            try {
                const sdk = await import('/sdk/audio_bundle.mjs');
                const files = await sdk.FilesetResolver.forAudioTasks(location.origin + '/sdk/wasm');
                const started = performance.now();
                task = await sdk.TextToSpeech.createFromOptions(files, {
                    baseOptions: { modelAssetPath: location.origin + '/models/' + name, delegate: 'CPU' },
                    defaultVoiceId: 'af_heart', speakingRate: 1, cacheDirectory: ':nocache',
                });
                const initMs = performance.now() - started;
                const audio = await task.synthesize('Hello world.');
                const samples = audio.samples;
                if (!(samples instanceof Float32Array) || !samples.length) {
                    throw Error('No floating-point audio samples');
                }
                const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
                if (audio.sampleRateHz !== 24000 || !(rms > 0.0001) ||
                    !samples.every(Number.isFinite)) throw Error('Invalid or silent PCM');
                window.__mediaPipeWebProbe = { done: true, success: true, initMs,
                    sampleRateHz: audio.sampleRateHz, sampleCount: samples.length, rms };
            } catch (error) {
                window.__mediaPipeWebProbe = { done: true, success: false,
                    error: String(error), stack: String(error.stack || '') };
            } finally {
                try { await task?.close(); } catch { /* diagnostic cleanup */ }
            }
        })();
    }, path.posix.basename(asset.path));
    await page.waitForFunction(() => window.__mediaPipeWebProbe?.done === true, null, { timeout: 240000 });
    result = { ...result, ...await page.evaluate(() => window.__mediaPipeWebProbe), pageErrors };
    if (pageErrors.length) result.success = false;
} catch (error) {
    result = { ...result, success: false, error: String(error) };
} finally {
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, JSON.stringify(result, null, 2));
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
}
console.log('ISOLATED PLAIN WEB MEDIAPIPE:', JSON.stringify(result, null, 2));
console.log('Report:', reportFile);
if (!result.success) process.exitCode = 1;
