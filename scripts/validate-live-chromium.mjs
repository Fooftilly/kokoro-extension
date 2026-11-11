// Live model-backed Chromium MV3 validation. Explicit opt-in and no model weights in git.
import { execFileSync } from 'node:child_process';
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
if (!['both', 'onnx', 'mediapipe', 'dictionary'].includes(providerFilter)) {
    throw Error('KOKORO_LIVE_PROVIDER must be both, onnx, mediapipe, or dictionary');
}
const originDownload = process.env.KOKORO_CHROMIUM_ORIGIN_DOWNLOAD === '1';
const headedConsent = process.env.KOKORO_CHROMIUM_HEADFUL_CONSENT === '1';
// All live model validation scopes eventually exercise the real dictionary
// Download button, including after an actual browser process restart. Optional
// host consent requires native browser UI even when the heavyweight model was
// preloaded only for a local inference test.
if (!headedConsent || !process.env.DISPLAY) {
    throw Error('Chromium live model acceptance requires headed X11 consent; ' +
        'run with KOKORO_CHROMIUM_HEADFUL_CONSENT=1 under Xvfb');
}
if (originDownload && !['mediapipe', 'onnx'].includes(providerFilter)) {
    throw Error('Real origin-download acceptance requires KOKORO_LIVE_PROVIDER=mediapipe or onnx');
}
const variants = [
    ...(providerFilter === 'mediapipe' || providerFilter === 'dictionary' ? [] :
        [dictionaryManifest(), manifestForVariant('onnx', 'q8')]),
    ...(providerFilter === 'onnx' || providerFilter === 'dictionary' ? [] :
        [manifestForVariant('mediapipe', 'cpu')]),
];
const sourceDir = path.join(os.tmpdir(), 'kokoro-live-models');
const resultsDir = path.resolve('dist/runtime-acceptance');
await mkdir(sourceDir, { recursive: true });
await mkdir(resultsDir, { recursive: true });
const local = new Map();
const byFilename = new Map();
for (const manifest of (originDownload ? [] : variants)) for (const asset of manifest.assets) {
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

/**
 * Evidence-only diagnostics. Do not manipulate the transfer, mock responses,
 * implicitly retry, or read a potentially in-flight Cache Storage entry.
 * Scrub query strings because redirected CDN URLs can include signed tokens.
 */
function summarizedOriginRequest(url) {
    try {
        const parsed = new URL(url);
        return parsed.origin + parsed.pathname.slice(0, 180);
    } catch {
        return '[unparseable URL]';
    }
}

async function captureOfficialOriginDownloadState(page, selector, events) {
    let ui;
    let watchdog;
    try {
        ui = await Promise.race([
            page.evaluate(selector => {
            const row = document.querySelector(selector);
            const status = row?.querySelector('.model-status');
            const progress = row?.querySelector('.model-download-progress');
            const button = row?.querySelector('.model-download');
            const warning = row?.querySelector('.model-storage-warning');
            const transfer = globalThis.__officialModelTransfer;
            const scrub = url => {
                try {
                    const parsed = new URL(url);
                    return parsed.origin + parsed.pathname.slice(0, 180);
                } catch {
                    return '[unparseable URL]';
                }
            };
            return {
                rowFound: !!row,
                status: status?.textContent || null,
                progressHidden: progress?.hidden ?? null,
                progressValue: progress?.hasAttribute('value') ? progress.value : null,
                buttonText: button?.textContent || null,
                buttonDisabled: button?.disabled ?? null,
                warning: warning && !warning.hidden ? warning.textContent : null,
                transfer: transfer ? {
                    requests: transfer.requests.map(scrub),
                    receivedBytesByUrl: Object.fromEntries(Object.entries(
                        transfer.bytesByUrl).map(([url, bytes]) => [scrub(url), bytes])),
                    completedUrls: transfer.completedUrls.map(scrub),
                    unexpectedUrls: transfer.unexpectedUrls.map(scrub),
                } : null,
            };
            }, selector),
            new Promise((_, reject) => {
                watchdog = setTimeout(() => reject(Error(
                    'UI diagnostic snapshot exceeded 5 seconds')), 5000);
            }),
        ]);
    } catch (error) {
        ui = { inspectionError: String(error) };
    } finally {
        clearTimeout(watchdog);
    }
    return { ui, networkEvents: [...events] };
}

/**
 * Exercise the native optional-host permission confirmation in the isolated,
 * headed Xvfb browser. Never pregrant the host or mock chrome.permissions.
 */
async function acceptOfficialOriginHostPermission(page, manifest, rowSelector, button, networkEvents) {
    const approvedHost = new URL(manifest.assets[0].url).origin + '/*';
    const allowedHosts = new Set([
        'https://huggingface.co/*',
        'https://raw.githubusercontent.com/*',
    ]);
    if (!allowedHosts.has(approvedHost)) {
        throw Error('Unapproved origin for browser permission acceptance');
    }
    const initiallyGranted = await page.evaluate(host =>
        chrome.permissions.contains({ origins: [host] }), approvedHost);
    // An existing grant would skip the consent prompt and invalidate this test.
    if (initiallyGranted) throw Error('Optional host already granted before user interaction');
    await page.bringToFront();
    await button.click();

    // Chromium's native optional-extension-permission prompt is not an HTML
    // dialog. This manually scoped Xvfb test uses actual X11 XTest key events
    // to interact with the real browser UI, not a permissions API stub.
    await page.waitForTimeout(1200);
    const pending = await page.locator(rowSelector + ' .model-status').textContent();
    const afterClick = await page.evaluate(host =>
        chrome.permissions.contains({ origins: [host] }), approvedHost);
    if (afterClick || !pending.includes('Waiting for model download permission')) {
        throw Error('Unexpected host-permission UI state before confirmation: ' +
            JSON.stringify({ afterClick, pending }));
    }
    let nativeInput;
    try {
        // The prebuilt Playwright image provides Chromium and its exact Linux
        // dependencies, but does not bundle xdotool or an X11 window manager.
        // Send the same native Tab/Return events via XTest in the installed
        // libX11/libXtst libraries, without relying on apt mirrors.
        const nativePython = process.env.KOKORO_NATIVE_PYTHON;
        if (!nativePython || !path.isAbsolute(nativePython)) {
            throw Error('Pinned setup-python absolute interpreter path is required');
        }
        nativeInput = JSON.parse(execFileSync(nativePython, [
            path.resolve('scripts/native-chromium-dialog-key.py'),
        ], { encoding: 'utf8', timeout: 5000 }).trim());
        if (nativeInput.x11XTest !== true || nativeInput.nativeKeys !== 'Tab Return') {
            throw Error('Native X11 input did not confirm both dialog keys');
        }
    } catch (error) {
        throw Error('Cannot interact with headed Chromium permission prompt: ' +
            String(error.message || error));
    }
    try {
        await page.waitForFunction(async host =>
            await chrome.permissions.contains({ origins: [host] }),
        approvedHost, { timeout: 10000 });
    } catch (error) {
        const snapshot = await captureOfficialOriginDownloadState(page, rowSelector, networkEvents);
        throw Error('Chromium host permission was not granted after native UI input: ' +
            JSON.stringify({ cause: String(error), nativeInput, ...snapshot }));
    }
    const hostGrantEvidence = {
        host: approvedHost, initiallyGranted: false,
        acceptedAfterNativeX11Input: true, grantedByBrowser: true,
    };
    return hostGrantEvidence;
}

/**
 * Independently exercise the real packaged extension's local-model Download
 * control against its pinned upstream HTTPS URLs. Do not use the preloaded
 * loopback fixture: it would bypass consent, browser CORS and download UI.
 * This intentionally runs only when the separate heavyweight mode is opted in.
 */
async function downloadModelFromOfficialOrigin(page, manifest) {
    if (!((manifest.provider === 'mediapipe' && manifest.variant === 'cpu') ||
        (manifest.provider === 'onnx' && manifest.variant === 'q8'))) {
        throw Error('Only pinned MediaPipe CPU and ONNX q8 variants are supported here');
    }
    const rowSelector = '[data-variant="' + manifest.provider + '-' + manifest.variant + '"]';
    // Force a true install instead of accidentally passing on a previous run's
    // cache. This explicit harness action never downloads replacement data.
    await page.evaluate(async ({ provider, variant }) => {
        const [{ ModelDataStore }, { manifestForVariant }] = await Promise.all([
            import('./model-data-store.js'), import('./model-catalog.js'),
        ]);
        const store = new ModelDataStore({
            origin: chrome.runtime.getURL('/'), cacheStorage: caches,
            fetchImpl: () => { throw Error('Unexpected fetch during test reset'); },
            responseClass: Response, streamClass: TransformStream,
        });
        await store.remove(manifestForVariant(provider, variant));
    }, { provider: manifest.provider, variant: manifest.variant });
    // The ONNX engine is independently installable: keep any earlier
    // MediaPipe CPU/GPU cache entries (including partial entries) untouched.
    // Snapshot metadata before this user's model install, without fetching.
    const otherProviderBefore = manifest.provider === 'onnx'
        ? await page.evaluate(async () => {
            const [{ ModelDataStore }, { manifestForVariant }] = await Promise.all([
                import('./model-data-store.js'), import('./model-catalog.js'),
            ]);
            const store = new ModelDataStore({
                origin: chrome.runtime.getURL('/'), cacheStorage: caches,
                fetchImpl: () => { throw Error('Snapshot unexpectedly fetched data'); },
                responseClass: Response, streamClass: TransformStream,
            });
            return Promise.all(['cpu', 'gpu'].map(async variant => ({
                variant, ...await store.status(manifestForVariant('mediapipe', variant)),
            })));
        }) : null;
    await page.reload();
    await page.waitForFunction(selector => {
        const row = document.querySelector(selector);
        return row?.querySelector('.model-status')?.textContent?.includes('Not installed') &&
            row?.querySelector('.model-download')?.disabled === false;
    }, rowSelector, { timeout: 30000 });

    // Count actual received stream bytes (not advertised Content-Length or
    // nominal model size). Instrument only this extension page's fetch; reject
    // any unpinned HTTP(S) request during the user-initiated download.
    await page.evaluate(expectedUrls => {
        const original = globalThis.fetch.bind(globalThis);
        const expected = new Set(expectedUrls);
        const transfer = { requests: [], bytesByUrl: {}, completedUrls: [], unexpectedUrls: [] };
        globalThis.__officialModelTransfer = transfer;
        globalThis.fetch = async (input, options) => {
            const url = String(input?.url || input);
            if (/^https?:/i.test(url) && !expected.has(url)) {
                transfer.unexpectedUrls.push(url);
                throw Error('Unexpected network URL during official model install: ' + url);
            }
            if (!expected.has(url)) return original(input, options);
            transfer.requests.push(url);
            const response = await original(input, options);
            if (!response.ok || !response.body) return response;
            transfer.bytesByUrl[url] = 0;
            const body = response.body.pipeThrough(new TransformStream({
                transform(chunk, controller) {
                    transfer.bytesByUrl[url] += chunk.byteLength;
                    controller.enqueue(chunk);
                },
                flush() { transfer.completedUrls.push(url); },
            }));
            return new Response(body, {
                status: response.status, statusText: response.statusText,
                headers: response.headers,
            });
        };
    }, manifest.assets.map(asset => asset.url));
    // Observe only real page HTTP(S) activity (including redirects). Keep a
    // bounded record, never the signed CDN query tokens or response bodies.
    // A 295-MB SRI fetch may buffer before the page can see any stream bytes.
    const networkEvents = [];
    const record = (event, request, extra = {}) => {
        if (!/^https?:/i.test(request.url())) return;
        networkEvents.push({
            event, url: summarizedOriginRequest(request.url()),
            elapsedMs: Math.round(performance.now() - networkStart), ...extra,
        });
        if (networkEvents.length > 60) networkEvents.shift();
    };
    const networkStart = performance.now();
    page.on('request', request => record('request', request));
    page.on('response', response => record('response', response.request(), {
        status: response.status(),
        contentLength: response.headers()['content-length'] || null,
    }));
    page.on('requestfinished', request => record('finished', request));
    page.on('requestfailed', request => record('failed', request, {
        failure: request.failure() || null,
    }));
    const button = page.locator(rowSelector + ' .model-download');
    const hostGrantEvidence = await acceptOfficialOriginHostPermission(
        page, manifest, rowSelector, button, networkEvents);
    try {
        await page.waitForFunction(selector => {
            const row = document.querySelector(selector);
            const status = row?.querySelector('.model-status')?.textContent || '';
            const finished = status.includes('Installed') &&
                row?.querySelector('.model-download-progress')?.value === 100;
            return finished ||
                /permission.*(denied|failed)|Cannot request|Download failed|Download cancelled|Cannot inspect model cache/i.test(status);
        }, rowSelector, { timeout: 900000 });
    } catch (error) {
        const diagnostics = await captureOfficialOriginDownloadState(page, rowSelector, networkEvents);
        throw Error(manifest.provider + ' official-origin UI acceptance did not settle: ' +
            JSON.stringify({ cause: String(error), ...diagnostics }));
    }
    const uiStatus = await page.locator(rowSelector + ' .model-status').textContent();
    if (!uiStatus.includes('Installed')) {
        const diagnostics = await captureOfficialOriginDownloadState(page, rowSelector, networkEvents);
        throw Error(manifest.provider + ' official download did not complete through UI: ' +
            JSON.stringify({ uiStatus, ...diagnostics }));
    }
    const report = await page.evaluate(async ({ provider, variant, selector }) => {
        const [{ ModelDataStore, formatModelSize }, { manifestForVariant }] = await Promise.all([
            import('./model-data-store.js'), import('./model-catalog.js'),
        ]);
        const m = manifestForVariant(provider, variant);
        const store = new ModelDataStore({
            origin: chrome.runtime.getURL('/'), cacheStorage: caches,
            fetchImpl: () => { throw Error('Unexpected fetch during post-download verification'); },
            responseClass: Response, streamClass: TransformStream,
        });
        const status = await store.status(m);
        const verified = await store.verifyAndPruneCorrupt(m);
        const dictionary = provider === 'onnx'
            ? await store.verifyAndPruneCorrupt((await import('./model-catalog.js')).dictionaryManifest())
            : null;
        const mediaPipeUntouched = provider === 'onnx'
            ? await Promise.all(['cpu', 'gpu'].map(async choice => ({
                variant: choice, ...await store.status(manifestForVariant('mediapipe', choice)),
            })))
            : null;
        const transfer = globalThis.__officialModelTransfer;
        const row = document.querySelector(selector);
        const permission = await chrome.permissions.contains({
            origins: [new URL(m.assets[0].url).origin + '/*'],
        });
        const expectedUrls = m.assets.map(asset => asset.url);
        const receivedBytes = expectedUrls.reduce((sum, url) =>
            sum + (transfer.bytesByUrl[url] || 0), 0);
        return {
            success: true, provider, variant, permission,
            expectedBytes: m.assets.reduce((sum, asset) => sum + asset.bytes, 0),
            receivedBytes, cachedBytes: status.storedBytes,
            verifiedAssets: m.assets.map(asset => ({ path: asset.path, bytes: asset.bytes })),
            dictionaryIntegrityVerified: dictionary
                ? dictionary.ready && dictionary.removedAssets === 0 && dictionary.missingAssets === 0
                : null,
            otherProviderStatusAfter: mediaPipeUntouched,
            requests: transfer.requests, completedUrls: transfer.completedUrls,
            unexpectedUrls: transfer.unexpectedUrls,
            fullSha256Verified: verified.ready && verified.removedAssets === 0 &&
                verified.missingAssets === 0,
            displayedSizeMatchesManifest: row.querySelector('.model-download').textContent
                .includes(formatModelSize(status.totalBytes)) &&
                row.querySelector('.model-status').textContent
                    .includes(formatModelSize(status.totalBytes)),
            progressPercent: row.querySelector('.model-download-progress').value,
            uiStatus: row.querySelector('.model-status').textContent,
        };
    }, { provider: manifest.provider, variant: manifest.variant, selector: rowSelector });
    const expectedUrls = manifest.assets.map(asset => asset.url);
    if (manifest.provider === 'onnx' &&
        (!report.dictionaryIntegrityVerified ||
            JSON.stringify(otherProviderBefore) !==
                JSON.stringify(report.otherProviderStatusAfter))) {
        throw Error('ONNX install damaged dictionary or altered MediaPipe cache: ' +
            JSON.stringify({ dictionaryVerified: report.dictionaryIntegrityVerified,
                otherProviderBefore, otherProviderAfter: report.otherProviderStatusAfter }));
    }
    if (!report.permission || !report.fullSha256Verified ||
        !report.displayedSizeMatchesManifest ||
        report.receivedBytes !== report.expectedBytes ||
        report.cachedBytes !== report.expectedBytes || report.progressPercent !== 100 ||
        report.unexpectedUrls.length ||
        report.requests.length !== expectedUrls.length ||
        expectedUrls.some((url, i) =>
            report.requests[i] !== url || !report.completedUrls.includes(url))) {
        throw Error('Official ' + manifest.provider + ' UI transfer verification failed: ' + JSON.stringify(report));
    }
    return { ...report, hostGrantEvidence,
        otherProviderStatusBefore: otherProviderBefore };
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
        channel: 'chromium', headless: !headedConsent,
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
        dictionaryUiDownloadAcceptance, results, originDownload,
        providerFilter,
        networkRequirement: providerFilter === 'dictionary'
            ? 'offline during dictionary persistence/verification; no inference attempted'
            : 'offline during every local synthesis probe',
        cachePopulation: originDownload
            ? providerFilter + ' weights downloaded through real user-facing Download control from official HTTPS origin; no loopback preload'
            : providerFilter === 'dictionary'
                ? 'no model weights downloaded; direct pinned dictionary HTTPS and model-manager UI acceptance only'
                : 'heavy weights preloaded from verified pinned bytes over authenticated loopback; dictionary official HTTPS and model-manager UI checked separately',
        scope: originDownload
            ? 'Chromium ' + providerFilter + ' CPU official-origin UI download, pinned bytes/SHA-256 and offline synthesis; other engine and Firefox untested'
            : providerFilter === 'dictionary'
                ? 'Chromium dictionary-only UI/Cache acceptance; no large speech models or audio synthesis'
                : 'Linux Chromium MV3 extension origin; no subjective audio-quality or complete download-manager acceptance',
    }, null, 2));
    for (const manifest of variants) {
        // Direct HTTPS CMUdict cache acceptance already ran in the preflight.
        // Never substitute a loopback copy for the dictionary in origin mode.
        if (originDownload && manifest.provider === 'dictionary') continue;
        const page = await context.newPage();
        let crashed = false;
        let stage = 'model-cache-population';
        let originModelAcceptance = null;
        let onnxPlaybackAcceptance = null;
        page.on('pageerror', error => errors.push(String(error)));
        page.on('crash', () => { crashed = true; });
        try {
            await page.goto('chrome-extension://' + extensionId + '/benchmark.html');
            if (originDownload) {
                stage = 'official-origin-download-via-real-model-manager-ui';
                originModelAcceptance = await downloadModelFromOfficialOrigin(page, manifest);
            } else {
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
            }
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
        if (!result.success && manifest.provider === 'mediapipe' && !originDownload) {
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
            if (originDownload && manifest.provider === 'onnx' && result.success) {
                stage = 'offline-audio-manager-onnx-english-wav-playback';
                onnxPlaybackAcceptance = await page.evaluate(async () => {
                    const { AudioManager } = await import('./audio-manager.js');
                    const manager = new AudioManager();
                    try {
                        // This is a disposable extension profile; verify the
                        // actual reader queue and storage-selected backend.
                        await chrome.storage.local.set({ pendingTtsBackend: 'onnx', pendingApiUrl: '' });
                        manager.setSentences([
                            { text: 'Hello world.' },
                            { text: 'zzzzqwertyword.' },
                        ]);
                        const url = await manager.getAudio(0);
                        if (!url.startsWith('blob:')) throw Error('ONNX did not return local WAV URL');
                        const response = await fetch(url);
                        if (!response.ok) throw Error('Unable to read local WAV Blob');
                        const bytes = new Uint8Array(await response.arrayBuffer());
                        if (bytes.length < 46) throw Error('ONNX WAV was empty');
                        const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                        const tag = (start, count) =>
                            String.fromCharCode(...bytes.subarray(start, start + count));
                        const sampleRateHz = wav.getUint32(24, true);
                        const audioBytes = wav.getUint32(40, true);
                        if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE' ||
                            sampleRateHz !== 24000 || audioBytes < 2 ||
                            bytes.length !== 44 + audioBytes) {
                            throw Error('ONNX AudioManager output is not a valid 24-kHz WAV');
                        }
                        let unsupported = null;
                        try { await manager.getAudio(1); }
                        catch (error) { unsupported = String(error); }
                        if (!unsupported || !/Missing English pronunciation|Unsupported English text/.test(unsupported)) {
                            throw Error('Unknown English word did not fail closed: ' + unsupported);
                        }
                        if (navigator.onLine !== false) throw Error('ONNX playback was not offline');
                        return { success: true, backend: 'onnx', sampleRateHz, audioBytes,
                            unknownWordsRejected: true, networkOffline: true };
                    } catch (error) {
                        return { success: false, error: String(error),
                            stack: String(error.stack || '') };
                    } finally {
                        manager.clear();
                        if (manager.localProvider) await manager.localProvider.close();
                    }
                });
                if (!onnxPlaybackAcceptance.success) {
                    throw Error('Chromium ONNX real reading-path acceptance failed: ' +
                        JSON.stringify(onnxPlaybackAcceptance));
                }
            }
            console.log(result.success ? 'REAL MODEL INFERENCE' : 'MODEL INFERENCE FAILURE', result);
            results.push({ provider: manifest.provider, variant: manifest.variant,
                offlineAttempted: true, offlineInference: result.success === true,
                originModelAcceptance, onnxPlaybackAcceptance, ...result });
            await saveReport();
        } catch (error) {
            const failure = { provider: manifest.provider, variant: manifest.variant,
                success: false, crashed, stage, originModelAcceptance,
                onnxPlaybackAcceptance, error: String(error) };
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
        channel: 'chromium', headless: !headedConsent,
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
            // A direct pinned CORS dictionary fetch earlier in the harness
            // is not a user-granted optional host permission. This separate
            // host must be authorized via the real Download button and native
            // Chromium dialog, including after a true browser restart.
            const dictionaryHostGrant = await acceptOfficialOriginHostPermission(
                reopened, dictionaryManifest(), '[data-variant="dictionary-english"]',
                downloadButton, []);
            await reopened.waitForFunction(() => {
                const row = document.querySelector('[data-variant="dictionary-english"]');
                return row?.querySelector('.model-download')?.textContent ===
                    'Cancel download' && row?.querySelector('.model-download')?.disabled === false &&
                    globalThis.__dictionaryUiCancelledFetches === 1;
            }, null, { timeout: 30000 });
            await downloadButton.click();
            await reopened.waitForFunction(() => {
                const row = document.querySelector('[data-variant="dictionary-english"]');
                return row?.querySelector('.model-status')?.textContent?.includes('Download cancelled') &&
                    row?.querySelector('.model-download')?.textContent?.startsWith('Download') &&
                    row?.querySelector('.model-download')?.disabled === false &&
                    row?.querySelector('.model-download-progress')?.hidden === true;
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
                    row?.querySelector('.model-download-progress')?.value === 100;
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
                nativePermissionGrant: dictionaryHostGrant,
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
        // A later dictionary UI failure must not overwrite a *passing*,
        // previously saved browser-restart/cache-persistence verification.
        // The dictionary UI reports its own failure independently above.
        if (!browserRestartAcceptance?.success) {
            browserRestartAcceptance = { success: false, browserProcessRestarted: true,
                error: String(error) };
        }
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
