// Live model-backed Chromium MV3 validation. Explicit opt-in and no model weights in git.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, createReadStream, createWriteStream, writeSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import {
    READER_ACCEPTANCE_SPEECH,
    buildReaderAcceptanceEpub,
} from './reader-acceptance-epub.mjs';
import {
    ARTICLE_SELECTION_SPEECH,
    articleSelectionStorageConfig,
    assertDistinctArticleSelectionAudioHashes,
    buildArticleSelectionFixtureHtml,
    originArticleSelectionStageEnabled,
    requireArticleSelectionBackend,
} from './article-selection-acceptance.mjs';
import {
    LONG_FORM_SENTENCE_COUNT,
    assertBoundedAudioManagerStats,
    assertLongFormCacheWindowNear,
    assertLongFormHeapDelta,
    buildLongFormVisitIndexes,
    longFormStorageConfig,
    originLongFormMemoryStageEnabled,
    requireLongFormBackend,
} from './long-form-memory-acceptance.mjs';
import { buildCurrentProviderSnapshot } from './live-chromium-report.mjs';
import {
    assertOnnxOovG2pDisclosure,
    assertOovG2pDisclosureReport,
    buildOovG2pDisclosureReport,
    OOV_FAIL_CLOSED_NEEDLE,
    OOV_PROBE_WORD,
} from './oov-g2p-disclosure-acceptance.mjs';
// Extension .js modules are ESM in the browser while package.json is CommonJS
// for the build tool. Copy pure modules into temporary .mjs files for Node.
const catalogFile = path.join(os.tmpdir(), 'kokoro-runtime-model-catalog.mjs');
await writeFile(catalogFile, await readFile(path.resolve('model-catalog.js')));
const { manifestForVariant, dictionaryManifest } = await import(pathToFileURL(catalogFile).href);
const longerSampleFile = path.join(os.tmpdir(),
    'kokoro-longer-shared-english-sample.mjs');
await writeFile(longerSampleFile,
    await readFile(path.resolve('longer-shared-english-sample.js')));
const {
    LONGER_SHARED_ENGLISH_SAMPLE,
    LONGER_SHARED_ENGLISH_BUTTON_ID,
    assertLongerSharedEnglishSample,
} = await import(pathToFileURL(longerSampleFile).href);

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

const liveStartedAt = Date.now();
const resultsDir = path.resolve('dist/runtime-acceptance');
await mkdir(resultsDir, { recursive: true });
const progressLogPath = path.join(resultsDir, 'progress.log');

function liveHeartbeat(label, detail, options = {}) {
    // writeSync(2) bypasses Node's full stderr buffering under non-TTY CI pipes.
    // Stage lines go to progress.log (stall watchdog). Keepalive "alive" lines
    // must NOT touch progress.log — they previously defeated the watchdog.
    const toProgress = options.toProgress !== false;
    const elapsedSec = Math.round((Date.now() - liveStartedAt) / 1000);
    const suffix = detail === undefined ? '' : ' ' + JSON.stringify(detail);
    const line = '[live-chromium ' + elapsedSec + 's] ' + label + suffix + '\n';
    try { writeSync(2, line); } catch { /* ignore */ }
    if (toProgress) {
        try { appendFileSync(progressLogPath, line); } catch { /* ignore */ }
    }
}

async function withTimeout(promise, ms, label) {
    let watchdog;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                watchdog = setTimeout(() => reject(Error(
                    label + ' exceeded ' + ms + 'ms')), ms);
            }),
        ]);
    } finally {
        clearTimeout(watchdog);
    }
}

/** Stage progress.log beats while a long Playwright wait runs (stall watchdog). */
async function withProgressBeats(label, promise, detail = {}) {
    const started = Date.now();
    liveHeartbeat(label, { ...detail, phase: 'start' });
    const timer = setInterval(() => {
        liveHeartbeat(label, {
            ...detail,
            phase: 'waiting',
            elapsedMs: Date.now() - started,
        });
    }, 15000);
    timer.unref?.();
    try {
        const result = await promise;
        liveHeartbeat(label, {
            ...detail,
            phase: 'done',
            elapsedMs: Date.now() - started,
        });
        return result;
    } finally {
        clearInterval(timer);
    }
}

liveHeartbeat('harness-start', { providerFilter, originDownload, headedConsent });
// Stderr-only keepalive; progress.log stays stage-gated for the stall watchdog.
const aliveTimer = setInterval(
    () => liveHeartbeat('alive', undefined, { toProgress: false }), 15000);
aliveTimer.unref?.();

const variants = [
    ...(providerFilter === 'mediapipe' || providerFilter === 'dictionary' ? [] :
        [dictionaryManifest(), manifestForVariant('onnx', 'q8')]),
    ...(providerFilter === 'onnx' || providerFilter === 'dictionary' ? [] :
        [manifestForVariant('mediapipe', 'cpu')]),
];
const sourceDir = path.join(os.tmpdir(), 'kokoro-live-models');
await mkdir(sourceDir, { recursive: true });
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
    liveHeartbeat('official-origin-host-permission-start', {
        provider: manifest.provider, variant: manifest.variant,
    });
    const hostGrantEvidence = await acceptOfficialOriginHostPermission(
        page, manifest, rowSelector, button, networkEvents);
    liveHeartbeat('official-origin-host-permission-done', {
        host: hostGrantEvidence.host,
    });
    try {
        liveHeartbeat('official-origin-download-wait-start', {
            provider: manifest.provider, timeoutMs: 900000,
        });
        await page.waitForFunction(selector => {
            const row = document.querySelector(selector);
            const status = row?.querySelector('.model-status')?.textContent || '';
            const finished = status.includes('Installed') &&
                row?.querySelector('.model-download-progress')?.value === 100;
            return finished ||
                /permission.*(denied|failed)|Cannot request|Download failed|Download cancelled|Cannot inspect model cache/i.test(status);
        }, rowSelector, { timeout: 900000 });
        liveHeartbeat('official-origin-download-wait-done');
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

// Real packaged benchmark-page test using downloaded, SHA-verified models.
// No model test is started by visiting the page; each inference is a UI click.
async function acceptLocalBenchmarkUi(page, extensionId, manifest) {
    const key = manifest.provider + '-' + manifest.variant;
    const rowSelector = '[data-variant="' + key + '"]';
    liveHeartbeat('local-benchmark-ui-goto', { key });
    await page.goto('chrome-extension://' + extensionId + '/benchmark.html');
    await page.waitForFunction(selector => {
        const row = document.querySelector(selector);
        return !!row && row.querySelector('.model-test')?.disabled === false;
    }, rowSelector, { timeout: 30000 });
    liveHeartbeat('local-benchmark-ui-ready', { key });
    const readEnglishRow = async () => page.evaluate(key => {
        const row = document.querySelector('#sharedEnglishComparisonRows tr[data-backend="' + key + '"]');
        const rows = document.querySelectorAll('#sharedEnglishComparisonRows tr');
        const model = document.querySelector('[data-variant="' + key + '"]');
        if (!row || rows.length !== 1 ||
            !model?.querySelector('.model-status')?.textContent.includes('warm (3 runs, shared English text)') ||
            model.querySelector('.model-choose')?.disabled ||
            document.querySelector('#serverStatus')?.textContent !== 'Not tested' ||
            !document.querySelector('#serverAudio')?.hidden ||
            navigator.onLine !== false) {
            throw Error('Packaged local English benchmark did not produce an isolated offline row');
        }
        const cells = Array.from(row.cells, cell => cell.textContent.trim());
        const values = cells.slice(1).map(Number.parseFloat);
        if (values.length !== 4 || values.some(v => !Number.isFinite(v) || v <= 0)) {
            throw Error('Local comparison displayed invalid measured timings: ' + JSON.stringify(cells));
        }
        return { cells, coldPrepMs: values[0], p50Ms: values[1],
            p95Ms: values[2], rtfP50: values[3] };
    }, key);
    liveHeartbeat('local-benchmark-ui-first-test-click', { key });
    await page.locator(rowSelector + ' .model-test').click();
    await withProgressBeats('local-benchmark-ui-first-wait', page.waitForFunction(key => {
        const model = document.querySelector('[data-variant="' + key + '"]');
        return document.querySelector('#sharedEnglishComparisonRows tr[data-backend="' + key + '"]') &&
            model?.querySelector('.model-choose')?.disabled === false;
    }, key, { timeout: 180000 }), { key });
    const first = await readEnglishRow();
    liveHeartbeat('local-benchmark-ui-first-row', { key, p50Ms: first.p50Ms });
    await page.locator('#benchmarkText').fill('zzzzqwertyword.');
    const afterEdit = await page.locator('#sharedEnglishComparisonRows tr').count();
    if (afterEdit !== 0) throw Error('Benchmark kept stale result after user edited English sample');
    let ipaOnlyExcluded = null;
    if (manifest.provider === 'onnx') {
        await page.locator(rowSelector + ' .model-test').click();
        await withProgressBeats('local-benchmark-ui-ipa-wait', page.waitForFunction(selector => {
            const model = document.querySelector(selector);
            return model?.querySelector('.model-status')?.textContent.includes('IPA-only diagnostic') &&
                model.querySelector('.model-choose')?.disabled === true;
        }, rowSelector, { timeout: 180000 }), { key });
        if (await page.locator('#sharedEnglishComparisonRows tr').count() !== 0) {
            throw Error('IPA-only ONNX fallback entered shared-English comparison');
        }
        ipaOnlyExcluded = true;
        liveHeartbeat('local-benchmark-ui-ipa-excluded', { key });
    }
    await page.locator('#benchmarkText').fill('Hello world.');
    liveHeartbeat('local-benchmark-ui-retest-click', { key });
    await page.locator(rowSelector + ' .model-test').click();
    await withProgressBeats('local-benchmark-ui-retest-wait', page.waitForFunction(key => {
        const model = document.querySelector('[data-variant="' + key + '"]');
        return document.querySelector('#sharedEnglishComparisonRows tr[data-backend="' + key + '"]') &&
            model?.querySelector('.model-choose')?.disabled === false;
    }, key, { timeout: 180000 }), { key });
    const restored = await readEnglishRow();
    liveHeartbeat('local-benchmark-ui-done', { key });
    return { success: true, provider: manifest.provider, variant: manifest.variant,
        sharedSample: 'Hello world.', first, restored, clearedOnEdit: true,
        ipaOnlyExcluded, backendSelectionTested: true, networkOffline: true,
        noImplicitFastApi: true, rows: 1 };
}

/** #57: real overlay controls for ONNX (incl. Retry) and MediaPipe. */
async function acceptOverlayControls(page, extensionId, backend) {
    const {
        overlaySeedForBackend,
        assertOverlayWavSnapshot,
        assertOverlaySettings,
        assertOverlayPlaybackConfirmed,
        assertOverlayPausedAfterToggle,
        buildOverlayControlsReport,
    } = await import('./overlay-controls-acceptance.mjs');
    const includeRetry = backend === 'onnx';
    const seed = overlaySeedForBackend(backend, { includeUnsupported: includeRetry });
    liveHeartbeat('overlay-controls-start', { backend });
    // Seed from the existing extension-origin tab — chrome.storage is unavailable
    // on a fresh about:blank page. Dedicated overlay tab still avoids MediaPipe
    // WASM probe residue detaching #audio on the probe page.
    await page.evaluate(async storage => {
        await chrome.storage.local.set(storage);
    }, seed);
    const overlayPage = await page.context().newPage();
    try {
        await overlayPage.goto('chrome-extension://' + extensionId + '/overlay.html');
        // #audio is display:none in overlay.css — wait for attached, not visible.
        await overlayPage.waitForSelector('#audio', { state: 'attached', timeout: 30000 });
        const overlayReady = index => {
            const spans = document.querySelectorAll('.sentence');
            return spans.length === 3 && spans[index]?.classList.contains('highlight') &&
                document.getElementById('audio')?.src.startsWith('blob:') &&
                document.getElementById('loadingSpinner')?.style.display === 'none';
        };
        await withProgressBeats(
            'overlay-controls-wait-ready',
            overlayPage.waitForFunction(overlayReady, 0, { timeout: 180000 }),
            { backend },
        );
        liveHeartbeat('overlay-controls-ready', { backend });
        // Prefer page.evaluate over locator('#audio') — avoids detach races.
        const firstUrl = await overlayPage.evaluate(() => {
            const audio = document.getElementById('audio');
            if (!audio?.src?.startsWith('blob:')) {
                throw Error('Overlay #audio missing after ready');
            }
            return audio.src;
        });
        const firstWav = await overlayPage.evaluate(async () => {
            const audio = document.getElementById('audio');
            const bytes = new Uint8Array(await (await fetch(audio.src)).arrayBuffer());
            const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const tag = (start, length) =>
                String.fromCharCode(...bytes.subarray(start, start + length));
            const audioBytes = wav.getUint32(40, true);
            if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE' ||
                wav.getUint32(24, true) !== 24000 || audioBytes < 2 ||
                bytes.length !== 44 + audioBytes) {
                throw Error('Overlay emitted malformed WAV');
            }
            if (!audio.paused || document.getElementById('playPause').textContent !== 'Play') {
                throw Error('Autoplay-disabled overlay unexpectedly started playing');
            }
            if (navigator.onLine !== false) throw Error('Overlay was not offline');
            return { sampleRateHz: 24000, audioBytes, initiallyPaused: true };
        });
        assertOverlayWavSnapshot(firstWav);
        await overlayPage.locator('#seekFwd').click();
        await overlayPage.waitForFunction(overlayReady, 1, { timeout: 180000 });
        await overlayPage.locator('#seekBack').click();
        await overlayPage.waitForFunction(overlayReady, 0, { timeout: 180000 });
        await overlayPage.locator('#speed').selectOption('1.25');
        await overlayPage.evaluate(() => {
            const slider = document.getElementById('volumeControl');
            slider.value = '0.4';
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const settings = await overlayPage.evaluate(() => {
            const audio = document.getElementById('audio');
            return { rate: audio.playbackRate, volume: audio.volume, paused: audio.paused };
        });
        assertOverlaySettings(settings);
        liveHeartbeat('overlay-controls-play-pause', { backend });
        // Device-level pause/resume: require playing event + currentTime advance.
        // navigate() already sets "Playing sentence" before play() resolves.
        await overlayPage.evaluate(() => {
            const audio = document.getElementById('audio');
            if (!audio) return;
            audio.muted = true;
            audio.__kokoroPlayProof = {
                playingEvent: false,
                startTime: audio.currentTime,
            };
            audio.addEventListener('playing', () => {
                audio.__kokoroPlayProof.playingEvent = true;
            }, { once: true });
        });
        await overlayPage.locator('#playPause').click();
        await overlayPage.waitForFunction(() => {
            const audio = document.getElementById('audio');
            const proof = audio?.__kokoroPlayProof;
            return audio && !audio.paused && audio.readyState >= 2 &&
                document.getElementById('playPause')?.textContent === 'Pause' &&
                proof?.playingEvent === true &&
                audio.currentTime > proof.startTime;
        }, null, { timeout: 30000 });
        assertOverlayPlaybackConfirmed(await overlayPage.evaluate(() => {
            const audio = document.getElementById('audio');
            const proof = audio?.__kokoroPlayProof || {};
            return {
                playingEvent: proof.playingEvent === true,
                startTime: proof.startTime,
                currentTime: audio?.currentTime ?? 0,
                paused: audio?.paused,
                button: document.getElementById('playPause')?.textContent || '',
                readyState: audio?.readyState ?? 0,
            };
        }));
        await overlayPage.locator('#playPause').click();
        await overlayPage.waitForFunction(() => {
            const audio = document.getElementById('audio');
            return audio && audio.paused &&
                document.getElementById('playPause')?.textContent === 'Play';
        }, null, { timeout: 30000 });
        assertOverlayPausedAfterToggle(await overlayPage.evaluate(() => {
            const audio = document.getElementById('audio');
            return {
                paused: audio?.paused,
                button: document.getElementById('playPause')?.textContent || '',
            };
        }));
        liveHeartbeat('overlay-controls-play-pause-done', { backend });
        let unsupportedSentenceRejected = false;
        let retryRestoredAudio = false;
        if (includeRetry) {
            await overlayPage.locator('#seekFwd').click();
            await withProgressBeats(
                'overlay-controls-seek-1',
                overlayPage.waitForFunction(overlayReady, 1, { timeout: 180000 }),
                { backend },
            );
            await overlayPage.locator('#seekFwd').click();
            await withProgressBeats(
                'overlay-controls-unsupported-wait',
                overlayPage.waitForFunction(() => {
                    const retry = document.getElementById('retry');
                    const spans = document.querySelectorAll('.sentence');
                    return spans.length === 3 && spans[2].classList.contains('highlight') &&
                        document.getElementById('status')?.textContent === 'Error playing audio.' &&
                        getComputedStyle(retry).display !== 'none' &&
                        document.getElementById('loadingSpinner')?.style.display === 'none';
                }, null, { timeout: 180000 }),
                { backend },
            );
            unsupportedSentenceRejected = true;
            await overlayPage.evaluate(async () => {
                await chrome.storage.local.set({
                    pendingText: 'Hello world. Hello world. Hello world.',
                    pendingContent: [
                        { type: 'text', content: 'Hello world.' },
                        { type: 'text', content: 'Hello world.' },
                        { type: 'text', content: 'Hello world.' },
                    ],
                });
            });
            await overlayPage.locator('#retry').click();
            await withProgressBeats(
                'overlay-controls-retry-wait',
                overlayPage.waitForFunction(oldUrl => {
                    const spans = document.querySelectorAll('.sentence');
                    const audio = document.getElementById('audio');
                    return spans.length === 3 && spans[0].classList.contains('highlight') &&
                        audio?.src.startsWith('blob:') && audio.src !== oldUrl &&
                        getComputedStyle(document.getElementById('retry')).display === 'none' &&
                        document.getElementById('loadingSpinner')?.style.display === 'none';
                }, firstUrl, { timeout: 180000 }),
                { backend },
            );
            retryRestoredAudio = true;
            liveHeartbeat('overlay-controls-retry-done', { backend });
        }
        const report = buildOverlayControlsReport({
            backend,
            includeRetry,
            playPauseToggled: true,
            playbackConfirmed: true,
            unsupportedSentenceRejected,
            retryRestoredAudio,
            sampleRateHz: firstWav.sampleRateHz,
            audioBytes: firstWav.audioBytes,
            rate: settings.rate,
            volume: settings.volume,
        });
        liveHeartbeat('overlay-controls-done', { backend, success: true });
        return report;
    } finally {
        if (!overlayPage.isClosed()) await overlayPage.close();
    }
}

/** #61: popup Test TTS backends CTA opens benchmark.html with three cards. */
async function acceptPopupTestTtsCta(context, extensionId) {
    const {
        assertPopupTestTtsSurface,
        buildPopupCtaAcceptanceReport,
    } = await import('./popup-test-tts-cta-acceptance.mjs');
    const popup = await context.newPage();
    try {
        await popup.goto('chrome-extension://' + extensionId + '/popup.html');
        await popup.waitForSelector('#openBenchmarkBtn', { timeout: 15000 });
        const surface = await popup.evaluate(() => {
            const cta = document.getElementById('openBenchmarkBtn');
            const hint = document.getElementById('openBenchmarkHint');
            const cards = [...document.querySelectorAll('.backend-card')].map(card => ({
                title: card.querySelector('.backend-card-title')?.textContent?.trim() || '',
                meta: card.querySelector('.backend-card-meta')?.textContent?.trim() || '',
                value: card.querySelector('input[name="ttsBackend"]')?.value || '',
            }));
            return {
                cta: cta?.textContent?.trim() || '',
                hint: hint?.textContent?.trim() || '',
                cardCount: cards.length,
                cards,
                mediapipeMeta: cards.find(c => c.value === 'mediapipe')?.meta || '',
            };
        });
        assertPopupTestTtsSurface(surface);
        const [benchmarkPage] = await Promise.all([
            context.waitForEvent('page', { timeout: 15000 }),
            popup.locator('#openBenchmarkBtn').click(),
        ]);
        await benchmarkPage.waitForLoadState('domcontentloaded');
        const benchmarkUrl = benchmarkPage.url();
        if (!benchmarkUrl.includes('/benchmark.html')) {
            throw Error('CTA did not open benchmark.html: ' + benchmarkUrl);
        }
        await benchmarkPage.waitForSelector('#sharedEnglishComparisonRows, [data-variant]', {
            timeout: 15000,
        });
        if (!benchmarkPage.isClosed()) await benchmarkPage.close();
        return buildPopupCtaAcceptanceReport({
            browser: 'chromium', benchmarkUrl,
        });
    } finally {
        if (!popup.isClosed()) await popup.close();
    }
}

// Both real local engines must contribute to the *same* benchmark page.
// Per-provider acceptance only proves the one-row case and does not exercise
// the shared comparison. This runs once, after both pinned models are cached.
async function acceptTwoBackendComparison(page, extensionId) {
    await page.goto('chrome-extension://' + extensionId + '/benchmark.html');
    const keys = ['onnx-q8', 'mediapipe-cpu'];
    await page.waitForFunction(keys => keys.every(key => {
        const row = document.querySelector('[data-variant="' + key + '"]');
        return row?.querySelector('.model-test')?.disabled === false &&
            row?.querySelector('.model-remove')?.disabled === false;
    }), keys, { timeout: 30000 });

    // #61 / KE-32: dual comparison uses the longer shared English paragraph.
    await page.locator('#' + LONGER_SHARED_ENGLISH_BUTTON_ID).click();
    const sharedSample = await page.locator('#benchmarkText').inputValue();
    assertLongerSharedEnglishSample(sharedSample);

    const selectedBefore = await page.evaluate(async () =>
        (await chrome.storage.sync.get({ ttsBackend: 'fastapi' })).ttsBackend);
    const measured = [];
    for (const key of keys) {
        await page.locator('[data-variant="' + key + '"] .model-test').click();
        await page.waitForFunction(key => {
            const model = document.querySelector('[data-variant="' + key + '"]');
            return model?.querySelector('.model-test')?.disabled === false &&
                model?.querySelector('.model-choose')?.disabled === false &&
                model?.querySelector('.model-status')?.textContent.includes(
                    'warm (3 runs, shared English text)') &&
                !!document.querySelector(
                    '#sharedEnglishComparisonRows tr[data-backend="' + key + '"]');
        }, key, { timeout: 600000 });

        const row = await page.evaluate(key => {
            const model = document.querySelector('[data-variant="' + key + '"]');
            const tbody = document.getElementById('sharedEnglishComparisonRows');
            const row = tbody.querySelector('tr[data-backend="' + key + '"]');
            const audio = model?.querySelector('audio');
            if (!row || tbody.rows.length < 1 || tbody.rows.length > 2 ||
                !audio?.src.startsWith('blob:') ||
                document.getElementById('serverStatus')?.textContent !== 'Not tested' ||
                !document.getElementById('serverAudio')?.hidden ||
                navigator.onLine !== false) {
                throw Error('Two-provider benchmark showed invalid/offline or server state');
            }
            const cells = Array.from(row.cells, c => c.textContent.trim());
            const numbers = cells.slice(1).map(Number.parseFloat);
            if (numbers.length !== 4 ||
                numbers.some(v => !Number.isFinite(v) || v <= 0)) {
                throw Error('Invalid shared-sample benchmark metrics: ' +
                    JSON.stringify(cells));
            }
            return { key, label: cells[0], coldPrepMs: numbers[0],
                p50Ms: numbers[1], p95Ms: numbers[2], rtfP50: numbers[3],
                rowCount: tbody.rows.length };
        }, key);
        measured.push(row);
    }
    if (measured[0].rowCount !== 1 || measured[1].rowCount !== 2) {
        throw Error('Two providers did not retain independent comparison rows');
    }
    const summary = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#sharedEnglishComparisonRows tr')];
        const summary = document.getElementById('sharedEnglishComparisonStatus')?.textContent;
        const keys = rows.map(row => row.dataset.backend);
        if (rows.length !== 2 || new Set(keys).size !== 2 ||
            !keys.includes('onnx-q8') || !keys.includes('mediapipe-cpu') ||
            !summary?.includes('Measured 2 local backend paths') ||
            !summary.includes('No ranking is inferred')) {
            throw Error('Shared comparison did not preserve both measured rows');
        }
        return summary;
    });
    // #61 / KE-30: export measured rows while both still present (local-only).
    const measuredResultsExport = await acceptMeasuredResultsExport(page, {
        sampleText: LONGER_SHARED_ENGLISH_SAMPLE,
        keys,
    });
    await page.locator('#benchmarkText').fill('Another shared English sample.');
    if (await page.locator('#sharedEnglishComparisonRows tr').count() !== 0) {
        throw Error('Editing shared sample did not clear both provider rows');
    }
    const selectedAfterMeasure = await page.evaluate(async () =>
        (await chrome.storage.sync.get({ ttsBackend: 'fastapi' })).ttsBackend);
    if (selectedAfterMeasure !== selectedBefore) {
        throw Error('Comparison silently changed the selected TTS backend');
    }

    // #61: measurement alone must not select a backend; Use this backend must.
    // Wait for choose-handler status text (not just sync) so a late ONNX
    // cache-check completion cannot overwrite a subsequent MediaPipe write.
    const readSyncBackend = async () => page.evaluate(async () =>
        (await chrome.storage.sync.get({ ttsBackend: 'fastapi' })).ttsBackend);
    await page.locator('[data-variant="onnx-q8"] .model-choose').click();
    await page.waitForFunction(() => {
        const status = document.querySelector(
            '[data-variant="onnx-q8"] .model-status')?.textContent || '';
        return status.includes('ONNX q8 selected for dictionary-supported English');
    }, null, { timeout: 15000 });
    const afterOnnxChoose = await readSyncBackend();
    if (afterOnnxChoose !== 'onnx') {
        throw Error('Use this backend did not select ONNX: ' + afterOnnxChoose);
    }
    await page.locator('[data-variant="mediapipe-cpu"] .model-choose').click();
    await page.waitForFunction(() => {
        const status = document.querySelector(
            '[data-variant="mediapipe-cpu"] .model-status')?.textContent || '';
        return status.includes('MediaPipe selected for future article and EPUB TTS');
    }, null, { timeout: 15000 });
    const afterMediaPipeChoose = await readSyncBackend();
    if (afterMediaPipeChoose !== 'mediapipe') {
        throw Error('Use this backend did not select MediaPipe: ' + afterMediaPipeChoose);
    }

    // #61 / KE-41b: after choose, dual must disclose dictionary-gated OOV
    // (IPA exclusion) — not broader long-form G2P. Fail-closed.
    const oovG2pDisclosureAcceptance =
        await acceptOnnxOovG2pDisclosureOnBenchmark(page);
    assertOovG2pDisclosureReport(oovG2pDisclosureAcceptance);

    return { success: true, providers: keys, sharedSample: LONGER_SHARED_ENGLISH_SAMPLE,
        measurements: measured, rowsBeforeEdit: 2, rowsAfterEdit: 0,
        bothRetainedOnOnePage: true,
        backendSelectionUnchangedDuringMeasure: true,
        selectedBackendBeforeChoose: selectedAfterMeasure,
        useThisBackend: {
            onnx: afterOnnxChoose,
            mediapipe: afterMediaPipeChoose,
            preferenceOnlyOnChoose: true,
            onnxStatusConfirmed: true,
            mediapipeStatusConfirmed: true,
        },
        selectedBackend: afterMediaPipeChoose, offline: true,
        serverTestNotTriggered: true, noAutomaticRanking: true, summary,
        measuredResultsExport, oovG2pDisclosureAcceptance };
}

/** KE-41b: OOV probe → IPA-only exclusion + shared dictionary-gated disclosure. */
async function acceptOnnxOovG2pDisclosureOnBenchmark(page) {
    liveHeartbeat('oov-g2p-disclosure-start');
    await page.locator('#benchmarkText').fill(OOV_PROBE_WORD + '.');
    await page.locator('[data-variant="onnx-q8"] .model-test').click();
    await withProgressBeats('oov-g2p-disclosure-ipa-wait', page.waitForFunction(() => {
        const model = document.querySelector('[data-variant="onnx-q8"]');
        return model?.querySelector('.model-status')?.textContent
            .includes('IPA-only diagnostic') &&
            model.querySelector('.model-choose')?.disabled === true;
    }, null, { timeout: 180000 }));
    if (await page.locator('#sharedEnglishComparisonRows tr').count() !== 0) {
        throw Error('OOV ONNX path entered shared-English comparison');
    }
    const statusText = await page.locator(
        '[data-variant="onnx-q8"] .model-status').textContent() || '';
    // Require an explicit fail-closed needle — IPA-only alone can also follow
    // unrelated synthesis errors (Devin: unverified rejection claim).
    if (!OOV_FAIL_CLOSED_NEEDLE.test(statusText) ||
        !/Missing English pronunciation|Unsupported English text/i.test(statusText)) {
        throw Error(
            'OOV dual status must cite dictionary fail-closed rejection: ' +
            statusText);
    }
    const probe = await page.evaluate(async (oovWord) => {
        const {
            discloseOnnxEnglishG2pLimits,
            listUnsupportedEnglishWords,
            loadCachedEnglishLexicon,
        } = await import('./english-g2p.js');
        const limits = discloseOnnxEnglishG2pLimits();
        const lexicon = await loadCachedEnglishLexicon(chrome, caches);
        const listed = listUnsupportedEnglishWords(oovWord + '.', lexicon);
        const listedAfterDigit = listUnsupportedEnglishWords(
            'Hello 2 ' + oovWord + '.', lexicon);
        return { limits, listed, listedAfterDigit };
    }, OOV_PROBE_WORD);
    if (!Array.isArray(probe.listed) || !probe.listed.includes(OOV_PROBE_WORD)) {
        throw Error('OOV word was not listed as unsupported: ' +
            JSON.stringify(probe.listed));
    }
    if (!Array.isArray(probe.listedAfterDigit) ||
        !probe.listedAfterDigit.includes(OOV_PROBE_WORD)) {
        throw Error(
            'OOV list stopped after digit instead of continuing: ' +
            JSON.stringify(probe.listedAfterDigit));
    }
    const report = buildOovG2pDisclosureReport({
        browser: 'chromium',
        ipaOnlyExcluded: true,
        unknownWordsRejected: true,
        oovProbe: OOV_PROBE_WORD,
        rejectionStatus: statusText,
    });
    assertOnnxOovG2pDisclosure({
        ...probe.limits,
        ipaOnlyExcluded: true,
        unknownWordsRejected: true,
        rejectionStatus: statusText,
    });
    assertOovG2pDisclosureReport(report);
    liveHeartbeat('oov-g2p-disclosure-done', { success: true });
    return report;
}

async function acceptMeasuredResultsExport(page, expected = {}) {
    const { assertMeasuredResultsExportPayload,
        assertMeasuredResultsExportReport,
        buildMeasuredResultsExportReport,
        isAcceptableMeasuredExportFilename,
        MEASURED_EXPORT_BUTTON_ID,
        MEASURED_EXPORT_STATUS_NEEDLE,
    } = await import('./measured-results-export-acceptance.mjs');
    liveHeartbeat('measured-results-export');
    const expectKeys = expected.keys || ['onnx-q8', 'mediapipe-cpu'];
    const expectSample = expected.sampleText || 'Hello world.';
    const exportReady = await page.evaluate((buttonId) => {
        const button = document.getElementById(buttonId);
        return {
            disabled: button?.disabled === true,
            exists: !!button,
            rowCount: document.querySelectorAll(
                '#sharedEnglishComparisonRows tr').length,
        };
    }, MEASURED_EXPORT_BUTTON_ID);
    if (!exportReady.exists || exportReady.disabled || exportReady.rowCount < 2) {
        throw Error(
            'Measured export control not ready with two rows: ' +
            JSON.stringify(exportReady));
    }
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        page.locator('#' + MEASURED_EXPORT_BUTTON_ID).click(),
    ]);
    const suggested = download.suggestedFilename() || '';
    // chrome.downloads.download often surfaces a UUID.json suggested name in
    // Playwright even when the extension requested the canonical filename.
    if (!isAcceptableMeasuredExportFilename(suggested)) {
        throw Error('Unexpected measured export filename: ' + suggested);
    }
    const savedPath = await download.path();
    if (!savedPath) {
        throw Error('Measured export download path missing');
    }
    const fromFile = JSON.parse(await readFile(savedPath, 'utf8'));
    assertMeasuredResultsExportPayload(fromFile, {
        keys: expectKeys, sampleText: expectSample,
    });
    const payload = await page.evaluate(() => globalThis.__kokoroLastMeasuredExport);
    assertMeasuredResultsExportPayload(payload, {
        keys: expectKeys, sampleText: expectSample,
    });
    // #61 / KE-46: assert store signing against the real export payload only.
    const {
        assertStoreSigningDisclosure,
        buildStoreSigningDisclosureReport,
    } = await import('./store-signing-disclosure-acceptance.mjs');
    assertStoreSigningDisclosure(fromFile);
    const assertedStoreSigning = assertStoreSigningDisclosure(payload);
    const storeSigningDisclosureAcceptance = buildStoreSigningDisclosureReport({
        browser: 'chromium',
        assertedFromExport: true,
        success: assertedStoreSigning.success === true,
    });
    await page.waitForFunction(needle => {
        const status = document.getElementById('measuredExportStatus')
            ?.textContent || '';
        const downloadId = globalThis.__kokoroLastMeasuredExportDownloadId;
        return status.includes(needle) && Number.isFinite(downloadId);
    }, MEASURED_EXPORT_STATUS_NEEDLE, { timeout: 15000 });
    const status = await page.locator('#measuredExportStatus').textContent();
    if (!status?.includes(MEASURED_EXPORT_STATUS_NEEDLE)) {
        throw Error('Measured export status missing local-only confirmation: ' +
            status);
    }
    const report = buildMeasuredResultsExportReport({
        browser: 'chromium',
        keys: expectKeys,
        sampleText: expectSample,
        statusConfirmed: true,
        downloadTriggered: true,
        fileContentsVerified: true,
        playwrightSuggestedFilename: suggested,
    });
    assertMeasuredResultsExportReport(report);
    report.storeSigningDisclosureAcceptance = storeSigningDisclosureAcceptance;
    return report;
}

/**
 * #61 / KE-27 + KE-29: loopback Kokoro-FastAPI stub for dual FastAPI card
 * and preference-honor reading paths (online).
 */
async function startFastApiSpeechStub() {
    const { MINIMAL_MP3_BYTES } = await import(
        './fastapi-server-card-acceptance.mjs');
    const body = Buffer.from(MINIMAL_MP3_BYTES);
    let speechHits = 0;
    const server = createServer((req, res) => {
        const pathOnly = String(req.url || '').split('?', 1)[0];
        if (req.method === 'GET' && pathOnly.endsWith('/models')) {
            const payload = JSON.stringify({
                data: [{ id: 'kokoro', object: 'model' }],
            });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Cache-Control': 'no-store',
            });
            res.end(payload);
            return;
        }
        if (req.method === 'POST' && pathOnly.endsWith('/audio/speech')) {
            speechHits += 1;
            const chunks = [];
            req.on('data', (part) => chunks.push(part));
            req.on('end', () => {
                // Delay the first body byte so streamed TTFB is measurable.
                res.writeHead(200, {
                    'Content-Type': 'audio/mpeg',
                    'Content-Length': body.length,
                    'Cache-Control': 'no-store',
                });
                const firstLen = Math.max(1, Math.min(64, body.length));
                const first = body.subarray(0, firstLen);
                const rest = body.subarray(firstLen);
                setTimeout(() => {
                    res.write(first);
                    setTimeout(() => res.end(rest), 20);
                }, 100);
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const apiUrl = 'http://127.0.0.1:' + port + '/v1/';
    return {
        apiUrl,
        speechHits: () => speechHits,
        async close() {
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

async function acceptFastApiServerCard(page, apiUrl) {
    const {
        SERVER_PLAYABLE_MP3_NEEDLE,
        SERVER_FIRST_BODY_BYTE_NEEDLE,
        SERVER_PLAYBACK_START_NEEDLE,
        SERVER_NOT_MEDIASOURCE_NEEDLE,
        SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE,
        FASTAPI_SELECTED_NEEDLE,
        BACKEND_BEFORE_CHOOSE,
        buildFastApiServerCardReport,
    } = await import('./fastapi-server-card-acceptance.mjs');

    // testFastApi refuses unless the selected backend is already fastapi.
    await page.evaluate(async (url) => {
        await chrome.storage.sync.set({
            ttsBackend: 'fastapi',
            apiUrl: url,
        });
    }, apiUrl);

    const sample = await page.locator('#benchmarkText').inputValue();
    if (!String(sample || '').trim()) {
        await page.locator('#benchmarkText').fill('FastAPI server card sample.');
    }

    await page.locator('#testServer').click();
    await page.waitForFunction((needles) => {
        const status = document.getElementById('serverStatus');
        const text = status?.textContent || '';
        const audio = document.getElementById('serverAudio');
        const choose = document.getElementById('chooseServer');
        return text.includes(needles.playable) &&
            text.includes(needles.ttfb) &&
            text.includes(needles.playbackStart) &&
            text.includes(needles.notMediaSource) &&
            text.includes(needles.mediasourceNotMeasured) &&
            status?.dataset?.streamingFirstBodyByteMeasured === 'true' &&
            status?.dataset?.playbackStartMeasured === 'true' &&
            status?.dataset?.mediasourceProgressiveTtfaMeasured === 'false' &&
            status?.dataset?.mediasourceProgressiveTtfaNotMeasured === 'true' &&
            Number.isFinite(Number(status?.dataset?.firstBodyByteP50Ms)) &&
            Number.isFinite(Number(status?.dataset?.playbackStartP50Ms)) &&
            audio && !audio.hidden &&
            String(audio.src || '').startsWith('data:audio') &&
            choose && choose.disabled === false;
    }, {
        playable: SERVER_PLAYABLE_MP3_NEEDLE,
        ttfb: SERVER_FIRST_BODY_BYTE_NEEDLE,
        playbackStart: SERVER_PLAYBACK_START_NEEDLE,
        notMediaSource: SERVER_NOT_MEDIASOURCE_NEEDLE,
        mediasourceNotMeasured:
            SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE,
    }, { timeout: 60000 });

    // Prove the stub MP3 actually decodes (not just a data: URL prefix).
    const audioDurationSec = await page.evaluate(async () => {
        const audio = document.getElementById('serverAudio');
        if (!audio) throw Error('serverAudio missing after FastAPI test');
        if (audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            await new Promise((resolve, reject) => {
                const onReady = () => {
                    cleanup();
                    resolve();
                };
                const onError = () => {
                    cleanup();
                    reject(Error('serverAudio failed to decode stub MP3'));
                };
                const cleanup = () => {
                    audio.removeEventListener('loadeddata', onReady);
                    audio.removeEventListener('error', onError);
                };
                audio.addEventListener('loadeddata', onReady, { once: true });
                audio.addEventListener('error', onError, { once: true });
                audio.load();
            });
        }
        if (!(audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) ||
            !(Number.isFinite(audio.duration) && audio.duration > 0)) {
            throw Error('Stub MP3 did not become decodeable: readyState=' +
                audio.readyState + ' duration=' + audio.duration);
        }
        return audio.duration;
    });

    // Capture TTFB / playback-start / MediaSource disclosure BEFORE
    // chooseServer — selection replaces status text with "FastAPI selected."
    // (dataset still survives). Observed values only — never invent defaults.
    const ttfb = await page.evaluate((needles) => {
        const status = document.getElementById('serverStatus');
        const text = status?.textContent || '';
        const measuredRaw = status?.dataset?.mediasourceProgressiveTtfaMeasured;
        const notMeasuredRaw =
            status?.dataset?.mediasourceProgressiveTtfaNotMeasured;
        const textHasNeedle = text.includes(needles.mediasourceNotMeasured);
        return {
            streamingFirstBodyByteMeasured:
                status?.dataset?.streamingFirstBodyByteMeasured === 'true',
            firstBodyByteP50Ms: Number(status?.dataset?.firstBodyByteP50Ms),
            synthesisP50Ms: Number(status?.dataset?.synthesisP50Ms),
            playbackStartMeasured:
                status?.dataset?.playbackStartMeasured === 'true' &&
                text.includes(needles.playbackStart) &&
                text.includes(needles.notMediaSource),
            playbackStartP50Ms: Number(status?.dataset?.playbackStartP50Ms),
            // Observed from page — omit/wrong values must fail assert.
            mediasourceProgressiveTtfaMeasured: measuredRaw === 'true'
                ? true
                : measuredRaw === 'false' ? false : null,
            mediasourceProgressiveTtfaNotMeasured:
                notMeasuredRaw === 'true' && textHasNeedle,
            mediasourceProgressiveTtfaDisclosure: textHasNeedle
                ? needles.mediasourceNotMeasured
                : '',
        };
    }, {
        playbackStart: SERVER_PLAYBACK_START_NEEDLE,
        notMediaSource: SERVER_NOT_MEDIASOURCE_NEEDLE,
        mediasourceNotMeasured:
            SERVER_MEDIASOURCE_PROGRESSIVE_TTFA_NOT_MEASURED_NEEDLE,
    });

    // Switch away from fastapi so chooseServer must write the preference.
    await page.evaluate(async (backend) => {
        await chrome.storage.sync.set({ ttsBackend: backend });
    }, BACKEND_BEFORE_CHOOSE);
    const beforeChoose = await page.evaluate(async () =>
        (await chrome.storage.sync.get({ ttsBackend: 'fastapi' })).ttsBackend);
    if (beforeChoose !== BACKEND_BEFORE_CHOOSE) {
        throw Error(
            'Could not seed non-fastapi before chooseServer: ' + beforeChoose);
    }

    await page.locator('#chooseServer').click();
    await page.waitForFunction((needle) => {
        const status = document.getElementById('serverStatus')?.textContent || '';
        return status.includes(needle);
    }, FASTAPI_SELECTED_NEEDLE, { timeout: 15000 });

    const selectedBackend = await page.evaluate(async () =>
        (await chrome.storage.sync.get({ ttsBackend: 'fastapi' })).ttsBackend);
    if (selectedBackend !== 'fastapi') {
        throw Error(
            'FastAPI Use this backend did not select fastapi: ' + selectedBackend);
    }

    const report = buildFastApiServerCardReport({
        browser: 'chromium',
        apiUrl,
        afterLocalDualComparison: true,
        backendBeforeChoose: beforeChoose,
        chooseChangedBackend: beforeChoose !== selectedBackend,
        decodeableMp3: true,
        audioDurationSec,
        streamingFirstBodyByteMeasured: ttfb.streamingFirstBodyByteMeasured,
        playbackStartMeasured: ttfb.playbackStartMeasured,
        firstBodyByteP50Ms: ttfb.firstBodyByteP50Ms,
        synthesisP50Ms: ttfb.synthesisP50Ms,
        playbackStartP50Ms: ttfb.playbackStartP50Ms,
        mediasourceProgressiveTtfaMeasured:
            ttfb.mediasourceProgressiveTtfaMeasured,
        mediasourceProgressiveTtfaNotMeasured:
            ttfb.mediasourceProgressiveTtfaNotMeasured,
        mediasourceProgressiveTtfaDisclosure:
            ttfb.mediasourceProgressiveTtfaDisclosure,
    });
    // #61 / KE-54: first-class progressive MediaSource TTFA remains unmeasured.
    const {
        assertProgressiveStreamingTtfaUnmeasured,
        buildProgressiveStreamingTtfaReport,
    } = await import('./mediasource-progressive-ttfa-acceptance.mjs');
    assertProgressiveStreamingTtfaUnmeasured(report);
    report.progressiveStreamingTtfaAcceptance =
        buildProgressiveStreamingTtfaReport({
            browser: 'chromium',
            assertedFromServerCard: true,
        });
    return report;
}

async function readOverlayMpegSnapshot(overlayFrame, stored) {
    return overlayFrame.evaluate(async (storedState) => {
        const audio = document.getElementById('audio');
        const status = document.getElementById('status');
        const spinner = document.getElementById('loadingSpinner');
        const audioUrl = audio?.src || '';
        if (!audioUrl.startsWith('data:audio') ||
            spinner?.style.display !== 'none' ||
            status?.textContent === 'Error playing audio.') {
            return null;
        }
        if (storedState.pendingTtsBackend !== 'fastapi') return null;
        return {
            mpegDataUrl: true,
            audioDataUrlPrefix: audioUrl.slice(0, 10),
            backend: storedState.pendingTtsBackend,
            serverUrl: storedState.pendingApiUrl || '',
            pendingText: storedState.pendingText || '',
            blockCount: Array.isArray(storedState.pendingContent)
                ? storedState.pendingContent.length : 0,
        };
    }, stored);
}

function pendingFastApiSpeechReady(stored, expectedSpeech, apiUrlNeedle) {
    if (stored.pendingTtsBackend !== 'fastapi') return false;
    if (!String(stored.pendingApiUrl || '').includes(apiUrlNeedle)) return false;
    const blocks = stored.pendingContent;
    const speechOk = Array.isArray(blocks) &&
        blocks.some(block => typeof block?.content === 'string' &&
            block.content.includes(expectedSpeech));
    const textOk = typeof stored.pendingText === 'string' &&
        stored.pendingText.includes(expectedSpeech);
    return speechOk || textOk;
}

async function pollOverlayFastApiMpegOnce(
    page, worker, expectedSpeech, mode, apiUrlNeedle,
) {
    const stored = await withTimeout(worker.evaluate(async () =>
        chrome.storage.local.get([
            'pendingText', 'pendingContent', 'pendingTtsBackend',
            'pendingApiUrl', 'pendingAutoplay',
        ]),
    ), 15000, 'fastapi preference storage poll');
    if (!pendingFastApiSpeechReady(stored, expectedSpeech, apiUrlNeedle)) {
        return null;
    }
    const hostMode = await withTimeout(page.evaluate(() =>
        document.getElementById('kokoro-overlay-container')?.dataset.mode ||
        null,
    ), 15000, 'fastapi preference overlay mode poll');
    if (mode && hostMode !== mode) return null;
    const overlayFrame = page.frames().find(frame =>
        frame.url().includes('/overlay.html'));
    if (!overlayFrame) return null;
    const snapshot = await withTimeout(
        readOverlayMpegSnapshot(overlayFrame, stored),
        30000, 'fastapi preference overlay MPEG snapshot');
    if (!snapshot) return null;
    return { speech: expectedSpeech, mode: hostMode, ...snapshot };
}

async function waitForOverlayFastApiMpeg(
    page, worker, expectedSpeech, mode, options = {},
) {
    const apiUrlNeedle = options.apiUrlNeedle || '/v1';
    const deadline = Date.now() + 90000;
    let lastError = null;
    let lastBeat = 0;
    while (Date.now() < deadline) {
        const elapsed = Date.now() - (deadline - 90000);
        if (elapsed - lastBeat >= 15000) {
            liveHeartbeat('wait-overlay-fastapi-mpeg', {
                expectedSpeech, mode, elapsedMs: elapsed,
            });
            lastBeat = elapsed;
        }
        try {
            const snapshot = await pollOverlayFastApiMpegOnce(
                page, worker, expectedSpeech, mode, apiUrlNeedle);
            if (snapshot) return snapshot;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Timed out waiting for FastAPI overlay MP3 for ' +
        expectedSpeech + (lastError ? (': ' + lastError) : ''));
}

async function clearPendingTtsSession(worker, tabId) {
    await withTimeout(worker.evaluate(async (id) => {
        if (id != null) {
            await chrome.tabs.sendMessage(id, { action: 'REMOVE_PLAYER' })
                .catch(() => {});
        }
        await chrome.storage.local.remove([
            'pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle',
            'pendingTtsBackend', 'pendingApiUrl', 'pendingAutoplay',
        ]);
    }, tabId), 15000, 'clearPendingTtsSession');
}

async function clickFloatingMicOnSentence(page, elementId) {
    await page.evaluate((id) => {
        const el = document.getElementById(id);
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, elementId);
    await page.waitForSelector('#kokoro-float-btn', {
        state: 'visible', timeout: 15000,
    });
    await page.locator('#kokoro-float-btn').click();
}

async function requireFastApiMpegSnap(snap, label) {
    if (!snap?.mpegDataUrl || snap.backend !== 'fastapi') {
        throw Error(label + ' did not honor FastAPI preference: ' +
            JSON.stringify(snap));
    }
    return snap;
}

async function honorChromiumSelection(page, worker, speech) {
    liveHeartbeat('fastapi-preference-selection');
    await clickFloatingMicOnSentence(page, 'selection-sentence');
    return requireFastApiMpegSnap(
        await waitForOverlayFastApiMpeg(
            page, worker, speech.selection, 'popup', {
                apiUrlNeedle: '127.0.0.1',
            }),
        'Selection');
}

async function honorChromiumArticle(page, worker, tabId, speech) {
    liveHeartbeat('fastapi-preference-article');
    await worker.evaluate(async (id) => {
        await chrome.tabs.update(id, { active: true });
    }, tabId);
    const commandBindings = await worker.evaluate(async () => {
        const commands = await chrome.commands.getAll();
        return commands.map(entry => ({
            name: entry.name, shortcut: entry.shortcut || '',
        }));
    });
    const readArticleBinding = commandBindings.find(
        entry => entry.name === 'read-article');
    if (!readArticleBinding?.shortcut) {
        throw Error('read-article command has no registered shortcut: ' +
            JSON.stringify(commandBindings));
    }
    await page.bringToFront();
    await page.locator('body').click({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(300);
    sendNativeReadArticleAltA(readArticleBinding, commandBindings);
    const articleArmedDeadline = Date.now() + 20000;
    let articleArmed = null;
    while (Date.now() < articleArmedDeadline) {
        const armed = await worker.evaluate(async () =>
            chrome.storage.local.get([
                'pendingText', 'pendingContent', 'pendingTtsBackend',
            ]));
        if (armed.pendingTtsBackend === 'fastapi' &&
            typeof armed.pendingText === 'string' &&
            armed.pendingText.includes(speech.articleFirst)) {
            articleArmed = armed;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!articleArmed) {
        throw Error('Native Alt+A did not arm FastAPI article storage');
    }
    return requireFastApiMpegSnap(
        await waitForOverlayFastApiMpeg(
            page, worker, speech.articleFirst, 'full', {
                apiUrlNeedle: '127.0.0.1',
            }),
        'Article');
}

function isFastApiDownloadItem(item) {
    const name = String(item?.filename || '').toLowerCase();
    const url = String(item?.url || '').toLowerCase();
    const mime = String(item?.mime || '').toLowerCase();
    // Chrome SW FastAPI downloads use data:audio/mpeg (no ".mp3" in URL).
    return name.endsWith('.mp3') ||
        url.startsWith('data:audio') ||
        url.includes('audio/mpeg') ||
        mime.includes('audio/mpeg') ||
        (url.startsWith('blob:') && name.includes('.mp3'));
}

async function honorChromiumDownload(page, worker, apiUrl, speechStub) {
    liveHeartbeat('fastapi-preference-download');
    const hitsBefore = speechStub.speechHits();
    await worker.evaluate(async (url) => {
        await chrome.storage.sync.set({
            ttsBackend: 'fastapi',
            apiUrl: url,
            mode: 'download',
            showFloatingButton: true,
        });
        await chrome.storage.local.remove([
            'pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle',
            'pendingTtsBackend', 'pendingApiUrl', 'pendingAutoplay',
        ]);
    }, apiUrl);
    // Arm onCreated before the click — search alone can miss data: URLs
    // whose filename is empty until the write finishes.
    await worker.evaluate(() => {
        globalThis.__kokoroDownloadProbe = {
            ids: [],
            listener(item) {
                globalThis.__kokoroDownloadProbe.ids.push(item.id);
            },
        };
        chrome.downloads.onCreated.addListener(
            globalThis.__kokoroDownloadProbe.listener);
    });
    const downloadBefore = await worker.evaluate(async () => {
        const items = await chrome.downloads.search({
            orderBy: ['-startTime'], limit: 20,
        });
        return items.map(item => item.id);
    });
    try {
        await clickFloatingMicOnSentence(page, 'download-sentence');
        const downloadDeadline = Date.now() + 30000;
        let downloadHit = null;
        while (Date.now() < downloadDeadline) {
            downloadHit = await worker.evaluate(async (beforeIds) => {
                const matchItem = (item) => {
                    const name = String(item?.filename || '').toLowerCase();
                    const url = String(item?.url || '').toLowerCase();
                    const mime = String(item?.mime || '').toLowerCase();
                    return name.endsWith('.mp3') ||
                        url.startsWith('data:audio') ||
                        url.includes('audio/mpeg') ||
                        mime.includes('audio/mpeg');
                };
                const items = await chrome.downloads.search({
                    orderBy: ['-startTime'], limit: 20,
                });
                const fromSearch = items.find(item =>
                    !beforeIds.includes(item.id) && matchItem(item));
                if (fromSearch) return fromSearch;
                // Probe only accelerates discovery; still require audio match
                // (do not accept unrelated onCreated items with a nonzero id).
                const armedIds = globalThis.__kokoroDownloadProbe?.ids || [];
                for (const id of armedIds) {
                    if (beforeIds.includes(id)) continue;
                    const [item] = await chrome.downloads.search({ id });
                    if (item && matchItem(item)) return item;
                }
                return null;
            }, downloadBefore);
            if (downloadHit) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!downloadHit) {
            const diagnostics = await worker.evaluate(async (beforeIds) => ({
                beforeIds,
                armedIds: globalThis.__kokoroDownloadProbe?.ids || [],
                recent: (await chrome.downloads.search({
                    orderBy: ['-startTime'], limit: 5,
                })).map(item => ({
                    id: item.id,
                    filename: item.filename || '',
                    urlPrefix: String(item.url || '').slice(0, 32),
                    mime: item.mime || '',
                    state: item.state || '',
                })),
            }), downloadBefore);
            throw Error(
                'FastAPI download mode did not create an MP3 download: ' +
                JSON.stringify(diagnostics));
        }
        if (!(speechStub.speechHits() > hitsBefore)) {
            throw Error(
                'FastAPI download mode did not hit loopback speech stub');
        }
        if (!isFastApiDownloadItem(downloadHit)) {
            throw Error(
                'FastAPI download item was not audio/mpeg: ' +
                JSON.stringify(downloadHit));
        }
        const afterDownloadBackend = await worker.evaluate(async () =>
            (await chrome.storage.sync.get({ ttsBackend: 'fastapi' })).ttsBackend);
        if (afterDownloadBackend !== 'fastapi') {
            throw Error(
                'Download path changed ttsBackend: ' + afterDownloadBackend);
        }
        return downloadHit;
    } finally {
        await worker.evaluate(() => {
            const probe = globalThis.__kokoroDownloadProbe;
            if (probe?.listener) {
                chrome.downloads.onCreated.removeListener(probe.listener);
            }
            delete globalThis.__kokoroDownloadProbe;
        }).catch(() => {});
    }
}

async function honorChromiumReader(context, extensionId, worker, apiUrl, speech) {
    liveHeartbeat('fastapi-preference-reader');
    await worker.evaluate(async (url) => {
        await chrome.storage.sync.set({
            ttsBackend: 'fastapi',
            apiUrl: url,
            mode: 'stream',
            autoplayReader: true,
        });
        await chrome.storage.local.remove([
            'pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle',
            'pendingTtsBackend', 'pendingApiUrl', 'pendingAutoplay',
            'pendingReaderReloadRevision',
        ]);
    }, apiUrl);
    const readerPage = await context.newPage();
    try {
        await readerPage.goto(
            'chrome-extension://' + extensionId + '/reader.html',
            { waitUntil: 'domcontentloaded', timeout: 30000 });
        await readerPage.locator('#fileInput').setInputFiles({
            name: 'fastapi-preference.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from(speech.reader, 'utf8'),
        });
        return requireFastApiMpegSnap(
            await waitForOverlayFastApiMpeg(
                readerPage, worker, speech.reader, null, {
                    apiUrlNeedle: '127.0.0.1',
                }),
            'Reader');
    } finally {
        if (!readerPage.isClosed()) await readerPage.close().catch(() => {});
    }
}

/**
 * #61 / KE-29: after FastAPI card selects fastapi, prove selection / article /
 * reader / download paths honor sync preference (loopback stub still up).
 */
async function acceptFastApiPreferenceHonor(context, extensionId, speechStub) {
    const {
        PREFERENCE_HONOR_SPEECH,
        buildPreferenceHonorFixtureHtml,
        buildFastApiPreferenceHonorReport,
    } = await import('./fastapi-preference-honor-acceptance.mjs');

    const worker = context.serviceWorkers()[0];
    if (!worker) throw Error('Extension service worker missing for preference honor');
    const apiUrl = speechStub.apiUrl;
    const selectedBackend = await worker.evaluate(async () =>
        (await chrome.storage.sync.get({ ttsBackend: 'fastapi' })).ttsBackend);
    if (selectedBackend !== 'fastapi') {
        throw Error(
            'Preference honor requires fastapi already selected: ' +
            selectedBackend);
    }

    await worker.evaluate(async (url) => {
        await chrome.storage.sync.set({
            ttsBackend: 'fastapi',
            apiUrl: url,
            mode: 'stream',
            showFloatingButton: true,
            autoplayReader: false,
        });
    }, apiUrl);

    const { server: fixtureServer, url: fixtureUrl } =
        await startArticleSelectionFixtureServer(
            buildPreferenceHonorFixtureHtml());
    const page = await context.newPage();
    let articleBlockCount = 2;
    try {
        liveHeartbeat('fastapi-preference-fixture');
        await page.goto(fixtureUrl, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await page.waitForFunction(() =>
            document.getElementById('selection-sentence') &&
            document.getElementById('article-first') &&
            document.getElementById('download-sentence'),
        null, { timeout: 15000 });

        const tabId = await withTimeout(worker.evaluate(async (url) => {
            const tabs = await chrome.tabs.query({ url });
            if (!tabs.length) throw Error('Preference fixture tab missing: ' + url);
            return tabs[0].id;
        }, fixtureUrl), 15000, 'preference-honor tab lookup');
        await ensureArticleSelectionContentScript(worker, tabId);
        await clearPendingTtsSession(worker, tabId);

        await honorChromiumSelection(page, worker, PREFERENCE_HONOR_SPEECH);
        await clearPendingTtsSession(worker, tabId);
        await page.waitForFunction(
            () => !document.getElementById('kokoro-overlay-container'),
            null, { timeout: 15000 });

        const articleSnap = await honorChromiumArticle(
            page, worker, tabId, PREFERENCE_HONOR_SPEECH);
        articleBlockCount = articleSnap.blockCount || 2;
        await clearPendingTtsSession(worker, tabId);
        await page.waitForFunction(
            () => !document.getElementById('kokoro-overlay-container'),
            null, { timeout: 15000 });

        await honorChromiumDownload(page, worker, apiUrl, speechStub);
    } finally {
        if (!page.isClosed()) await page.close().catch(() => {});
        try { fixtureServer.closeAllConnections?.(); } catch { /* ignore */ }
        await withTimeout(new Promise(resolve => {
            fixtureServer.close(() => resolve());
        }), 5000, 'preference fixtureServer.close').catch(() => {});
    }

    await honorChromiumReader(
        context, extensionId, worker, apiUrl, PREFERENCE_HONOR_SPEECH);

    return buildFastApiPreferenceHonorReport({
        browser: 'chromium',
        apiUrl,
        afterFastApiServerCard: true,
        articleBlockCount,
        speechStubHits: speechStub.speechHits(),
    });
}

// Browser-side readiness poll serialized by Playwright into the reader page.
// Nested helpers keep CodeFactor method complexity under the gate while the
// WAV fetch, revision recheck, and Prev/Next assertions stay atomic.
async function pollRealEpubChapterReady(
    { title, previousRevision, previousAudioUrl, previousAudioSha256, backend }) {
    // Must match READER_ACCEPTANCE_SPEECH in the harness module scope copy.
    const expectedSpeech = {
        'First Chapter': 'Hello first chapter.',
        'Second Chapter': 'Hello second chapter.',
        'Third Chapter': 'Hello third chapter.',
        'acceptance.txt': 'Hello plain text.',
    }[title];
    const expectedNav = (chapterTitle) => ({
        entries: chapterTitle === 'acceptance.txt' ? 1 : 3,
        prevDisabled: chapterTitle === 'First Chapter' ||
            chapterTitle === 'acceptance.txt',
        nextDisabled: chapterTitle === 'Third Chapter' ||
            chapterTitle === 'acceptance.txt',
    });
    const collectNav = () => {
        const active = document.querySelector('.playable-chapter.active');
        return {
            activeLabel: active?.querySelector('.chapter-label')?.textContent ?? null,
            activeHref: active?.dataset.href ?? null,
            entries: [...document.querySelectorAll('.playable-chapter')].map(el => ({
                label: el.querySelector('.chapter-label')?.textContent ?? null,
                href: el.dataset.href ?? null,
                active: el.classList.contains('active'),
            })),
            prevDisabled: document.getElementById('prevChapter').disabled,
            nextDisabled: document.getElementById('nextChapter').disabled,
        };
    };
    const navMatches = (chapterTitle) => {
        const expected = expectedNav(chapterTitle);
        const active = document.querySelector('.playable-chapter.active');
        const prev = document.getElementById('prevChapter');
        const next = document.getElementById('nextChapter');
        return document.querySelectorAll('.playable-chapter').length === expected.entries &&
            active?.querySelector('.chapter-label')?.textContent === chapterTitle &&
            prev?.disabled === expected.prevDisabled &&
            next?.disabled === expected.nextDisabled;
    };
    const pendingContentMatches = (stored) => {
        const blocks = stored.pendingContent;
        return Array.isArray(blocks) && blocks.length === 1 &&
            blocks[0].content === expectedSpeech;
    };
    const shellReady = (frame, audio, status, stored, revision, audioUrl) => [
        () => Boolean(frame && audio),
        () => document.getElementById('filePickerOverlay')?.style.display === 'none',
        () => navMatches(title),
        () => stored.pendingTitle === title && stored.pendingTtsBackend === backend,
        () => stored.pendingApiUrl === null || stored.pendingApiUrl === '',
        () => stored.pendingAutoplay === false,
        () => Number.isSafeInteger(revision) && revision > previousRevision,
        () => pendingContentMatches(stored),
        () => Boolean(audioUrl?.startsWith('blob:')),
        () => !previousAudioUrl || audioUrl !== previousAudioUrl,
        () => audio.paused,
        () => frame.getElementById('loadingSpinner')?.style.display === 'none',
        () => status?.textContent !== 'Error playing audio.',
        () => frame.getElementById('pageTitle')?.textContent === title,
        () => frame.querySelectorAll('.sentence').length >= 1,
        () => navigator.onLine === false,
    ].every(check => check());
    const stillStable = (frame, audio, audioUrl) => [
        () => audio.src === audioUrl,
        () => frame.getElementById('loadingSpinner')?.style.display === 'none',
        () => frame.getElementById('pageTitle')?.textContent === title,
        () => navMatches(title),
    ].every(check => check());
    const assertValidWav = (bytes, response, audioUrl, revision, wavBackend) => {
        const tag = (offset, count) =>
            String.fromCharCode(...bytes.subarray(offset, offset + count));
        const header = bytes.byteLength >= 44
            ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
        const audioBytes = header?.getUint32(40, true) ?? 0;
        if (tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE' &&
            header?.getUint32(24, true) === 24000 && audioBytes >= 2 &&
            bytes.length === 44 + audioBytes) {
            return audioBytes;
        }
        throw Error('Real EPUB reader WAV mismatch: ' + JSON.stringify({
            title, revision, backend: wavBackend,
            sourceKind: audioUrl.split(':', 1)[0],
            mime: response.headers.get('content-type'),
            length: bytes.length, riff: tag(0, 4), wave: tag(8, 4),
            rate: header?.getUint32(24, true) ?? null,
            audioBytes, expectedLength: 44 + audioBytes,
            leadBytes: [...bytes.subarray(0, 12)],
        }));
    };
    const sha256Hex = async (bytes) => {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)]
            .map(b => b.toString(16).padStart(2, '0')).join('');
    };

    const frame = document.getElementById('playerFrame')?.contentDocument;
    const audio = frame?.getElementById('audio');
    const status = frame?.getElementById('status');
    const stored = await chrome.storage.local.get([
        'pendingTitle', 'pendingTtsBackend', 'pendingApiUrl',
        'pendingReaderReloadRevision', 'pendingContent', 'pendingAutoplay',
    ]);
    const revision = stored.pendingReaderReloadRevision;
    const audioUrl = audio?.src;
    if (!shellReady(frame, audio, status, stored, revision, audioUrl)) return false;

    let response;
    let bytes;
    try {
        // The iframe owns this Blob URL; capture it before awaiting.
        response = await frame.defaultView.fetch(audioUrl);
        if (!response.ok) return false;
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
        // The player may revoke the URL while switching chapters.
        return false;
    }
    // Reject transitional snapshots rather than letting them pass or
    // fetching the newly cleared audio.src as a document URL.
    const latest = await chrome.storage.local.get([
        'pendingReaderReloadRevision', 'pendingTitle', 'pendingTtsBackend',
    ]);
    if (latest.pendingReaderReloadRevision !== revision ||
        latest.pendingTitle !== title || latest.pendingTtsBackend !== backend ||
        !stillStable(frame, audio, audioUrl)) {
        return false;
    }
    const audioBytes = assertValidWav(
        bytes, response, audioUrl, revision, stored.pendingTtsBackend);
    const audioSha256 = await sha256Hex(bytes);
    if (previousAudioSha256 && audioSha256 === previousAudioSha256) return false;
    return {
        title, revision, audioUrl, bytes: audioBytes, audioSha256,
        expectedSpeech, pendingContent: stored.pendingContent,
        blockCount: stored.pendingContent.length,
        backend: stored.pendingTtsBackend,
        serverUrl: stored.pendingApiUrl,
        paused: audio.paused,
        nav: collectNav(),
    };
}

function startArticleSelectionFixtureServer(html) {
    const fixtureServer = createServer((req, res) => {
        if (req.method === 'GET' && (req.url === '/' || req.url === '/article.html')) {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            res.end(html);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise(resolve => {
        fixtureServer.listen(0, '127.0.0.1', () => {
            const port = fixtureServer.address().port;
            resolve({
                server: fixtureServer,
                url: 'http://127.0.0.1:' + port + '/article.html',
            });
        });
    });
}

async function ensureArticleSelectionContentScript(worker, tabId) {
    await withTimeout(worker.evaluate(async (id) => {
        try {
            await chrome.tabs.sendMessage(id, { action: 'PING' });
        } catch {
            await chrome.scripting.executeScript({
                target: { tabId: id },
                files: [
                    'browser-polyfill.min.js', 'readability.js',
                    'overlay-position.js', 'content.js',
                ],
            });
            await new Promise(r => setTimeout(r, 150));
            await chrome.tabs.sendMessage(id, { action: 'PING' });
        }
    }, tabId), 30000, 'ensureArticleSelectionContentScript');
}

async function readOverlayWavSnapshot(overlayFrame, stored) {
    return overlayFrame.evaluate(async (storedState) => {
        const audio = document.getElementById('audio');
        const status = document.getElementById('status');
        const spinner = document.getElementById('loadingSpinner');
        const audioUrl = audio?.src;
        if (!audioUrl?.startsWith('blob:') ||
            spinner?.style.display !== 'none' ||
            status?.textContent === 'Error playing audio.' ||
            navigator.onLine !== false) {
            return null;
        }
        let response;
        let bytes;
        try {
            response = await fetch(audioUrl);
            if (!response.ok) return null;
            bytes = new Uint8Array(await response.arrayBuffer());
        } catch {
            return null;
        }
        if (audio.src !== audioUrl ||
            document.getElementById('loadingSpinner')?.style.display !== 'none') {
            return null;
        }
        const tag = (offset, count) =>
            String.fromCharCode(...bytes.subarray(offset, offset + count));
        const header = bytes.byteLength >= 44
            ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : null;
        const audioBytes = header?.getUint32(40, true) ?? 0;
        if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE' ||
            header?.getUint32(24, true) !== 24000 || audioBytes < 2 ||
            bytes.length !== 44 + audioBytes) {
            throw Error('Article/selection overlay WAV mismatch: ' +
                JSON.stringify({
                    length: bytes.length, riff: tag(0, 4), wave: tag(8, 4),
                    rate: header?.getUint32(24, true) ?? null, audioBytes,
                }));
        }
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const audioSha256 = [...new Uint8Array(digest)]
            .map(b => b.toString(16).padStart(2, '0')).join('');
        return {
            audioBytes,
            audioSha256,
            backend: storedState.pendingTtsBackend,
            serverUrl: storedState.pendingApiUrl,
            pendingText: storedState.pendingText || '',
            blockCount: Array.isArray(storedState.pendingContent)
                ? storedState.pendingContent.length : 0,
            autoplay: storedState.pendingAutoplay === true,
            offline: navigator.onLine === false,
        };
    }, stored);
}

async function waitForArticleSelectionOverlayWav(
    page, worker, expectedSpeech, mode, options = {},
) {
    const excludeAudioSha256 = options.excludeAudioSha256 || null;
    const deadline = Date.now() + 180000;
    let lastError = null;
    let lastBeat = 0;
    while (Date.now() < deadline) {
        const elapsed = Date.now() - (deadline - 180000);
        if (elapsed - lastBeat >= 15000) {
            liveHeartbeat('wait-overlay-wav', {
                expectedSpeech, mode, elapsedMs: elapsed,
                excludeAudioSha256: Boolean(excludeAudioSha256),
            });
            lastBeat = elapsed;
        }
        try {
            // Cap each CDP round-trip so a blocked service worker cannot stall
            // past the outer deadline (job previously cancelled at 30m with no report).
            const stored = await withTimeout(worker.evaluate(async () =>
                chrome.storage.local.get([
                    'pendingText', 'pendingContent', 'pendingTtsBackend',
                    'pendingApiUrl', 'pendingAutoplay',
                ]),
            ), 15000, 'article/selection storage poll');
            const blocks = stored.pendingContent;
            const speechOk = Array.isArray(blocks) &&
                blocks.some(block => typeof block?.content === 'string' &&
                    block.content.includes(expectedSpeech));
            if (!speechOk) {
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }
            const hostMode = await withTimeout(page.evaluate(() =>
                document.getElementById('kokoro-overlay-container')?.dataset.mode || null,
            ), 15000, 'article/selection overlay mode poll');
            if (mode && hostMode !== mode) {
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }
            const overlayFrame = page.frames().find(frame =>
                frame.url().includes('/overlay.html'));
            if (!overlayFrame) {
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }
            const snapshot = await withTimeout(
                readOverlayWavSnapshot(overlayFrame, stored),
                30000, 'article/selection overlay WAV snapshot');
            // After selection→article, pendingText can update before the overlay
            // replaces the previous blob URL; ignore the stale selection WAV.
            if (snapshot && excludeAudioSha256 &&
                snapshot.audioSha256 === excludeAudioSha256) {
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }
            if (snapshot) {
                return { speech: expectedSpeech, mode: hostMode, ...snapshot };
            }
        } catch (error) {
            const message = String(error);
            if (message.includes('Article/selection overlay WAV mismatch')) throw error;
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Timed out waiting for article/selection overlay WAV for ' +
        expectedSpeech + (lastError ? (': ' + lastError) : ''));
}

async function acceptFloatingMicSelection(page, worker, tabId, backend) {
    await page.evaluate(() => {
        const el = document.getElementById('selection-sentence');
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForSelector('#kokoro-float-btn', {
        state: 'visible', timeout: 15000,
    });
    await page.locator('#kokoro-float-btn').click();
    const selectionSnap = await waitForArticleSelectionOverlayWav(
        page, worker, ARTICLE_SELECTION_SPEECH.selection, 'popup');
    if (selectionSnap.backend !== backend ||
        selectionSnap.serverUrl !== null && selectionSnap.serverUrl !== '') {
        throw Error('Selection overlay left local backend: ' +
            JSON.stringify(selectionSnap));
    }
    await worker.evaluate(async (id) => {
        await chrome.tabs.sendMessage(id, { action: 'REMOVE_PLAYER' });
        await chrome.storage.local.remove([
            'pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle',
            'pendingTtsBackend', 'pendingApiUrl', 'pendingAutoplay',
        ]);
    }, tabId);
    await page.waitForFunction(
        () => !document.getElementById('kokoro-overlay-container'),
        null, { timeout: 15000 });
    return selectionSnap;
}

async function probeArticleExtraction(worker, tabId) {
    const articleExtract = await worker.evaluate(async (id) => {
        const parsed = await chrome.tabs.sendMessage(id, { action: 'PARSE_ARTICLE' });
        if (!parsed?.text || !Array.isArray(parsed.content)) {
            throw Error('PARSE_ARTICLE failed: ' + JSON.stringify(parsed));
        }
        return { text: parsed.text, blockCount: parsed.content.length };
    }, tabId);
    if (!articleExtract.text.includes(ARTICLE_SELECTION_SPEECH.articleFirst) ||
        !articleExtract.text.includes(ARTICLE_SELECTION_SPEECH.articleSecond)) {
        throw Error('Article extract missed fixture paragraphs: ' +
            JSON.stringify(articleExtract));
    }
    return articleExtract;
}

function sendNativeReadArticleAltA(readArticleBinding, commandBindings) {
    const nativePython = process.env.KOKORO_NATIVE_PYTHON;
    if (!nativePython || !path.isAbsolute(nativePython)) {
        throw Error('Pinned setup-python absolute interpreter path is required');
    }
    try {
        const nativeAltA = JSON.parse(execFileSync(nativePython, [
            path.resolve('scripts/native-chromium-keys.py'),
            'Alt_L', 'a',
        ], { encoding: 'utf8', timeout: 5000 }).trim());
        if (nativeAltA.x11XTest !== true || nativeAltA.nativeKeys !== 'Alt_L a') {
            throw Error('Native X11 input did not confirm Alt+A');
        }
        return nativeAltA;
    } catch (error) {
        throw Error('Cannot send native Alt+A for read-article command: ' +
            String(error.message || error) + '; bindings=' +
            JSON.stringify({ readArticleBinding, commandBindings }));
    }
}

async function waitForReadArticleStorageArmed(worker, backend) {
    const armedDeadline = Date.now() + 20000;
    while (Date.now() < armedDeadline) {
        const armed = await worker.evaluate(async () => chrome.storage.local.get([
            'pendingText', 'pendingContent', 'pendingTtsBackend',
        ]));
        if (typeof armed.pendingText === 'string' &&
            armed.pendingText.includes(ARTICLE_SELECTION_SPEECH.articleFirst) &&
            armed.pendingTtsBackend === backend) {
            return armed;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
}

async function acceptReadArticleCommand(
    page, worker, tabId, backend, options = {},
) {
    // Playwright/CDP keys never reach chrome.commands; use native X11 XTest.
    // background.js ignores read-article while CHECK_PLAYER_ACTIVE — ensure the
    // selection popup is fully gone before sending Alt+A.
    await page.waitForFunction(
        () => !document.getElementById('kokoro-overlay-container'),
        null, { timeout: 15000 });
    const playerStillActive = await withTimeout(worker.evaluate(async (id) => {
        try {
            const response = await chrome.tabs.sendMessage(id, {
                action: 'CHECK_PLAYER_ACTIVE',
            });
            return Boolean(response?.active);
        } catch {
            return false;
        }
    }, tabId), 15000, 'CHECK_PLAYER_ACTIVE before read-article');
    if (playerStillActive) {
        throw Error('Selection player still active before native Alt+A');
    }
    await worker.evaluate(async (id) => {
        await chrome.storage.local.remove([
            'pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle',
            'pendingTtsBackend', 'pendingApiUrl', 'pendingAutoplay',
        ]);
        await chrome.tabs.update(id, { active: true });
    }, tabId);
    const commandBindings = await worker.evaluate(async () => {
        const commands = await chrome.commands.getAll();
        return commands.map(entry => ({
            name: entry.name, shortcut: entry.shortcut || '',
        }));
    });
    const readArticleBinding = commandBindings.find(
        entry => entry.name === 'read-article');
    if (!readArticleBinding?.shortcut) {
        throw Error('read-article command has no registered shortcut: ' +
            JSON.stringify(commandBindings));
    }
    await page.bringToFront();
    await page.locator('body').click({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(300);
    const nativeAltA = sendNativeReadArticleAltA(readArticleBinding, commandBindings);
    const armed = await waitForReadArticleStorageArmed(worker, backend);
    if (!armed) {
        throw Error('Native Alt+A did not arm read-article storage: ' +
            JSON.stringify({ nativeAltA, readArticleBinding, commandBindings }));
    }
    const articleSnap = await waitForArticleSelectionOverlayWav(
        page, worker, ARTICLE_SELECTION_SPEECH.articleFirst, 'full', {
            excludeAudioSha256: options.excludeAudioSha256 || null,
        });
    if (articleSnap.backend !== backend ||
        (articleSnap.serverUrl !== null && articleSnap.serverUrl !== '')) {
        throw Error('Article overlay left local backend: ' +
            JSON.stringify(articleSnap));
    }
    if (!articleSnap.pendingText.includes(ARTICLE_SELECTION_SPEECH.articleFirst) ||
        !articleSnap.pendingText.includes(ARTICLE_SELECTION_SPEECH.articleSecond)) {
        throw Error('read-article command did not store extracted article text: ' +
            JSON.stringify({
                pendingText: articleSnap.pendingText,
                blockCount: articleSnap.blockCount,
            }));
    }
    if (articleSnap.blockCount < 1) {
        throw Error('read-article command stored empty pendingContent');
    }
    return { articleSnap, readArticleBinding, nativeAltA };
}

/**
 * Real webpage selection (floating mic → REQUEST_TTS) and article read
 * (native X11 Alt+A `read-article` command → handleTtsAction) against a
 * loopback fixture. Chromium onnx or mediapipe origin (KE-11 / KE-18).
 */
async function acceptRealArticleAndSelection(page, context, extensionId, backend) {
    requireArticleSelectionBackend(backend);
    liveHeartbeat('article-selection-fixture-start', { backend });
    const { server: fixtureServer, url: fixtureUrl } =
        await startArticleSelectionFixtureServer(buildArticleSelectionFixtureHtml());
    const worker = context.serviceWorkers()[0];
    if (!worker) throw Error('Extension service worker missing for article/selection');

    try {
        await withTimeout(worker.evaluate(async (storage) => {
            await chrome.storage.sync.set(storage);
            await chrome.storage.local.remove([
                'pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle',
                'pendingTtsBackend', 'pendingApiUrl', 'pendingAutoplay',
            ]);
        }, articleSelectionStorageConfig(backend)), 15000, 'article-selection storage seed');

        await context.setOffline(false);
        await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForFunction(() =>
            document.getElementById('selection-sentence') &&
            document.getElementById('article-first'),
        null, { timeout: 15000 });

        const tabId = await withTimeout(worker.evaluate(async (url) => {
            const tabs = await chrome.tabs.query({ url });
            if (!tabs.length) throw Error('Fixture tab not found for ' + url);
            return tabs[0].id;
        }, fixtureUrl), 15000, 'article-selection tab lookup');
        await ensureArticleSelectionContentScript(worker, tabId);
        await context.setOffline(true);

        liveHeartbeat('article-selection-floating-mic');
        const selectionSnap = await acceptFloatingMicSelection(
            page, worker, tabId, backend);
        liveHeartbeat('article-selection-mic-done', {
            audioBytes: selectionSnap.audioBytes,
        });
        const articleExtract = await withTimeout(
            probeArticleExtraction(worker, tabId),
            30000, 'PARSE_ARTICLE probe');
        liveHeartbeat('article-selection-native-alt-a', {
            excludeSelectionSha: selectionSnap.audioSha256?.slice(0, 12),
        });
        const { articleSnap, readArticleBinding, nativeAltA } =
            await acceptReadArticleCommand(page, worker, tabId, backend, {
                excludeAudioSha256: selectionSnap.audioSha256,
            });
        liveHeartbeat('article-selection-alt-a-done', {
            audioBytes: articleSnap.audioBytes,
            audioSha256: articleSnap.audioSha256?.slice(0, 12),
            nativeKeys: nativeAltA.nativeKeys,
        });

        assertDistinctArticleSelectionAudioHashes(
            selectionSnap.audioSha256, articleSnap.audioSha256);
        liveHeartbeat('article-selection-hashes-distinct');

        await withTimeout(worker.evaluate(async (id) => {
            await chrome.tabs.sendMessage(id, { action: 'REMOVE_PLAYER' }).catch(() => {});
        }, tabId), 15000, 'REMOVE_PLAYER after article');

        return {
            success: true,
            browser: 'Chromium',
            backend,
            fixtureUrl,
            selection: {
                path: 'floating-mic',
                mode: selectionSnap.mode,
                speech: ARTICLE_SELECTION_SPEECH.selection,
                audioBytes: selectionSnap.audioBytes,
                audioSha256: selectionSnap.audioSha256,
            },
            article: {
                path: 'read-article-command-native-x11',
                shortcut: readArticleBinding.shortcut,
                nativeKeys: nativeAltA.nativeKeys,
                mode: articleSnap.mode,
                speech: ARTICLE_SELECTION_SPEECH.articleFirst,
                extractedTextIncludesBothParagraphs: true,
                parseArticleProbeBlockCount: articleExtract.blockCount,
                blockCount: articleSnap.blockCount,
                audioBytes: articleSnap.audioBytes,
                audioSha256: articleSnap.audioSha256,
            },
            local24kHzWav: true,
            differentAudioPerPath: true,
            offline: true,
            noServerFallback: true,
            userBackendUnchanged: true,
        };
    } finally {
        // Drop keep-alive clients so close() cannot sit until the stall watchdog.
        liveHeartbeat('article-selection-fixture-close');
        try { fixtureServer.closeAllConnections?.(); } catch { /* ignore */ }
        await withTimeout(new Promise(resolve => {
            fixtureServer.close(() => resolve());
        }), 5000, 'article-selection fixtureServer.close').catch((closeError) => {
            liveHeartbeat('article-selection-fixture-close-timeout', {
                error: String(closeError).slice(0, 160),
            });
            try { fixtureServer.closeAllConnections?.(); } catch { /* ignore */ }
        });
    }
}

// Playwright serializes waitForFunction predicates into the page — Node
// module constants like LONG_FORM_SENTENCE_COUNT are not in scope there.
async function waitLongFormOverlayReady(page, index, label, timeoutMs = 180000) {
    await withTimeout(
        page.waitForFunction(({ idx, count }) => {
            const spans = document.querySelectorAll('.sentence');
            return spans.length >= count &&
                spans[idx]?.classList.contains('highlight') &&
                document.getElementById('audio')?.src.startsWith('blob:') &&
                document.getElementById('loadingSpinner')?.style.display === 'none' &&
                typeof window.__kokoroAudioManagerStats === 'function';
        }, { idx: index, count: LONG_FORM_SENTENCE_COUNT }, { timeout: timeoutMs }),
        timeoutMs + 10000, label);
}

async function seedLongFormOverlay(page, context, extensionId, backend) {
    const storage = longFormStorageConfig(backend);
    const worker = context.serviceWorkers()[0] ||
        await context.waitForEvent('serviceworker', { timeout: 30000 });
    if (!worker) throw Error('Extension service worker missing for long-form memory');
    await withTimeout(worker.evaluate(async (cfg) => {
        await chrome.storage.local.set(cfg);
    }, storage), 15000, 'long-form storage seed');
    await page.goto('chrome-extension://' + extensionId + '/overlay.html');
    await waitLongFormOverlayReady(
        page, 0, 'long-form overlay first sentence', 240000);
}

function readLongFormStats(page) {
    return page.evaluate(() => window.__kokoroAudioManagerStats());
}

function readLongFormHeap(page) {
    return page.evaluate(() => {
        const mem = performance.memory;
        return mem && Number.isFinite(mem.usedJSHeapSize)
            ? mem.usedJSHeapSize : null;
    });
}

function readLongFormWavMeta(page) {
    return page.evaluate(async () => {
        const audio = document.getElementById('audio');
        const bytes = new Uint8Array(await (await fetch(audio.src)).arrayBuffer());
        const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const tag = (start, length) =>
            String.fromCharCode(...bytes.subarray(start, start + length));
        const audioBytes = wav.getUint32(40, true);
        if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE' ||
            wav.getUint32(24, true) !== 24000 || audioBytes < 2 ||
            bytes.length !== 44 + audioBytes) {
            throw Error('Long-form overlay WAV mismatch');
        }
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const audioSha256 = [...new Uint8Array(digest)]
            .map(b => b.toString(16).padStart(2, '0')).join('');
        return {
            audioBytes, audioSha256, paused: audio.paused,
            offline: navigator.onLine === false,
        };
    });
}

async function walkLongFormSentences(page, visitIndexes) {
    let maxCacheSize = 0;
    let maxObjectUrlCount = 0;
    const samples = [];
    for (const index of visitIndexes) {
        if (index > 0) {
            await page.evaluate((target) => {
                document.querySelectorAll('.sentence')[target].click();
            }, index);
            await waitLongFormOverlayReady(
                page, index, 'long-form overlay sentence ' + index);
        }
        await page.waitForTimeout(250);
        const stats = await readLongFormStats(page);
        assertBoundedAudioManagerStats(stats);
        maxCacheSize = Math.max(maxCacheSize, stats.cacheSize);
        maxObjectUrlCount = Math.max(maxObjectUrlCount, stats.objectUrlCount);
        if (index === 0 || index === visitIndexes[visitIndexes.length - 1]) {
            samples.push({ index, ...(await readLongFormWavMeta(page)), ...stats });
        }
        if (index % 4 === 0) {
            liveHeartbeat('long-form-memory-progress', {
                index, cacheSize: stats.cacheSize,
                objectUrlCount: stats.objectUrlCount,
            });
        }
    }
    return { maxCacheSize, maxObjectUrlCount, samples };
}

// Walk ends before the last sentence. Return to 0 (outside the near-end
// retain window), await a fresh WAV, then jump to the last index and assert
// the cache window/URL actually moved while staying bounded.
async function jumpLongFormAcrossWindows(page, bounds) {
    const lastIndex = LONG_FORM_SENTENCE_COUNT - 1;
    liveHeartbeat('long-form-memory-jump-return-zero');
    await page.evaluate(() => {
        document.querySelectorAll('.sentence')[0].click();
    });
    await waitLongFormOverlayReady(page, 0, 'long-form return to first sentence');
    await page.waitForTimeout(250);
    const atZeroStats = await readLongFormStats(page);
    assertBoundedAudioManagerStats(atZeroStats);
    assertLongFormCacheWindowNear(atZeroStats, 0);
    const zeroWav = await readLongFormWavMeta(page);

    liveHeartbeat('long-form-memory-jump-to-last');
    await page.evaluate((target) => {
        document.querySelectorAll('.sentence')[target].click();
    }, lastIndex);
    await waitLongFormOverlayReady(page, lastIndex, 'long-form jump to last sentence');
    await page.waitForTimeout(250);
    const jumpStats = await readLongFormStats(page);
    assertBoundedAudioManagerStats(jumpStats);
    assertLongFormCacheWindowNear(jumpStats, lastIndex);
    const finalWav = await readLongFormWavMeta(page);
    if (finalWav.audioSha256 === zeroWav.audioSha256) {
        throw Error('Distant jump WAV hash matched index-0 hash: ' +
            JSON.stringify({
                zero: zeroWav.audioSha256, last: finalWav.audioSha256,
            }));
    }
    if (jumpStats.window.first === atZeroStats.window.first &&
        jumpStats.window.last === atZeroStats.window.last) {
        throw Error('Distant jump did not move cache window: ' +
            JSON.stringify({ atZero: atZeroStats.window, jump: jumpStats.window }));
    }
    return {
        maxCacheSize: Math.max(
            bounds.maxCacheSize, atZeroStats.cacheSize, jumpStats.cacheSize),
        maxObjectUrlCount: Math.max(
            bounds.maxObjectUrlCount, atZeroStats.objectUrlCount, jumpStats.objectUrlCount),
        jumpCacheSize: jumpStats.cacheSize,
        returnToZeroCacheSize: atZeroStats.cacheSize,
        windowAfterReturn: atZeroStats.window,
        windowAfterJump: jumpStats.window,
        zeroAudioSha256: zeroWav.audioSha256,
        jumpAudioSha256: finalWav.audioSha256,
        finalWav,
        samples: [
            { index: 0, phase: 'return-before-jump', ...zeroWav, ...atZeroStats },
            { index: lastIndex, phase: 'distant-jump', ...finalWav, ...jumpStats },
        ],
    };
}

async function readSyncTtsBackend(pageOrWorker) {
    return pageOrWorker.evaluate(async () =>
        (await chrome.storage.sync.get({ ttsBackend: 'fastapi' })).ttsBackend);
}

async function assertLongFormPrivacy(page, backend, finalWav, syncBefore) {
    const local = await page.evaluate(async () => chrome.storage.local.get([
        'pendingTtsBackend', 'pendingApiUrl', 'apiUrl',
    ]));
    if (local.pendingTtsBackend !== backend) {
        throw Error('pendingTtsBackend drifted from seeded onnx session: ' +
            JSON.stringify(local));
    }
    if (local.pendingApiUrl || local.apiUrl) {
        throw Error('Long-form acceptance saw a server URL: ' + JSON.stringify(local));
    }
    const syncAfter = await readSyncTtsBackend(page);
    if (syncAfter !== syncBefore) {
        throw Error('chrome.storage.sync ttsBackend changed during long-form: ' +
            JSON.stringify({ syncBefore, syncAfter }));
    }
    if (finalWav.offline !== true) {
        throw Error('Long-form overlay was not offline at end');
    }
    return { syncTtsBackend: syncAfter };
}

// Long-form memory: walk many ONNX overlay sentences while the opt-in
// AudioManager probe proves the cache/object-URL window stays bounded.
// Seed storage through the service worker — after article/selection the page
// is still on the HTTP fixture, where `chrome` is undefined.
async function acceptLongFormMemoryPerformance(page, context, extensionId, backend) {
    requireLongFormBackend(backend);
    liveHeartbeat('long-form-memory-start', { backend, sentences: LONG_FORM_SENTENCE_COUNT });
    const worker = context.serviceWorkers()[0] ||
        await context.waitForEvent('serviceworker', { timeout: 30000 });
    if (!worker) throw Error('Extension service worker missing for long-form memory');
    const syncBefore = await readSyncTtsBackend(worker);
    await seedLongFormOverlay(page, context, extensionId, backend);

    const heapBefore = await readLongFormHeap(page);
    const visitIndexes = buildLongFormVisitIndexes();
    if (visitIndexes.includes(LONG_FORM_SENTENCE_COUNT - 1)) {
        throw Error('Visit path must not already end on the distant-jump target');
    }
    const walk = await walkLongFormSentences(page, visitIndexes);
    const jump = await jumpLongFormAcrossWindows(page, walk);
    walk.samples.push(...jump.samples);

    const heapAfter = await readLongFormHeap(page);
    const heap = heapBefore != null && heapAfter != null
        ? assertLongFormHeapDelta(heapBefore, heapAfter)
        : null;
    const privacy = await assertLongFormPrivacy(
        page, backend, jump.finalWav, syncBefore);

    liveHeartbeat('long-form-memory-done', {
        maxCacheSize: jump.maxCacheSize,
        maxObjectUrlCount: jump.maxObjectUrlCount,
        heapGrowth: heap?.growth ?? null,
        windowAfterJump: jump.windowAfterJump,
    });
    return {
        success: true,
        browser: 'chromium',
        backend,
        sentenceCount: LONG_FORM_SENTENCE_COUNT,
        visitedCount: visitIndexes.length,
        maxCacheSize: jump.maxCacheSize,
        maxObjectUrlCount: jump.maxObjectUrlCount,
        jumpCacheSize: jump.jumpCacheSize,
        returnToZeroCacheSize: jump.returnToZeroCacheSize,
        windowAfterReturn: jump.windowAfterReturn,
        windowAfterJump: jump.windowAfterJump,
        zeroAudioSha256: jump.zeroAudioSha256,
        jumpAudioSha256: jump.jumpAudioSha256,
        distantJumpChangedWindow: true,
        local24kHzWav: true,
        offline: true,
        noServerFallback: true,
        acceptanceProbe: true,
        heap,
        samples: walk.samples,
        syncTtsBackend: privacy.syncTtsBackend,
        userBackendUnchanged: privacy.syncTtsBackend === syncBefore,
    };
}

// Verify that the real EPUB.js reader and embedded overlay—not a seeded
// pendingContent shortcut—create a local offline WAV for all three chapters.
// Also cover replacing the book with a TXT file through the same UI.
// backend is 'onnx' or 'mediapipe' (chromium-*-origin scopes).
async function acceptRealEpubReader(page, extensionId, backend) {
    if (backend !== 'onnx' && backend !== 'mediapipe') {
        throw Error('EPUB reader acceptance requires onnx or mediapipe backend');
    }
    await page.evaluate(async (ttsBackend) => {
        await chrome.storage.sync.set({
            ttsBackend, autoplayReader: false, continuousReader: false,
            mediaPipeVariant: 'cpu', localVoice: 'af_heart',
        });
    }, backend);
    await page.goto('chrome-extension://' + extensionId + '/reader.html');
    await page.waitForFunction(() =>
        document.querySelector('#fileInput') &&
        document.querySelector('#playerFrame')?.contentDocument?.getElementById('status'),
    null, { timeout: 30000 });

    const epub = await buildReaderAcceptanceEpub();
    await page.locator('#fileInput').setInputFiles({
        name: 'offline-reader-acceptance.epub',
        mimeType: 'application/epub+zip',
        buffer: epub,
    });

    const readReaderNavDiagnostics = async () => page.evaluate(() => {
        const prev = document.getElementById('prevChapter');
        const next = document.getElementById('nextChapter');
        const active = document.querySelector('.playable-chapter.active');
        return {
            activeLabel: active?.querySelector('.chapter-label')?.textContent ?? null,
            activeHref: active?.dataset.href ?? null,
            entries: [...document.querySelectorAll('.playable-chapter')].map(el => ({
                label: el.querySelector('.chapter-label')?.textContent ?? null,
                href: el.dataset.href ?? null,
                active: el.classList.contains('active'),
            })),
            prevDisabled: prev?.disabled ?? null,
            nextDisabled: next?.disabled ?? null,
            prevAriaDisabled: prev?.getAttribute('aria-disabled') ?? null,
            nextAriaDisabled: next?.getAttribute('aria-disabled') ?? null,
            pageTitle: document.getElementById('playerFrame')?.contentDocument
                ?.getElementById('pageTitle')?.textContent ?? null,
            status: document.getElementById('playerFrame')?.contentDocument
                ?.getElementById('status')?.textContent ?? null,
            pickerVisible: document.getElementById('filePickerOverlay')?.style.display !== 'none',
        };
    });
    const expectedNavForTitle = (title) => {
        if (title === 'First Chapter') return { prevDisabled: true, nextDisabled: false };
        if (title === 'Second Chapter') return { prevDisabled: false, nextDisabled: false };
        if (title === 'Third Chapter') return { prevDisabled: false, nextDisabled: true };
        if (title === 'acceptance.txt') return { prevDisabled: true, nextDisabled: true };
        return null;
    };
    const waitForChapter = async (title, previousRevision = 0, previousAudioUrl = null,
        previousAudioSha256 = null) => {
        // Playwright 1.65 treats an *async* waitForFunction predicate that
        // resolves to false/null as success (returns that falsy value). The
        // EPUB readiness poll must await chrome.storage + iframe WAV fetch, so
        // it cannot be a sync predicate. Drive the same atomic browser-side
        // poll via page.evaluate in Node until it returns a chapter snapshot.
        // WAV header mismatches fail closed immediately; transient not-ready
        // results retry until the deadline.
        const deadline = Date.now() + 180000;
        let lastError = null;
        while (Date.now() < deadline) {
            try {
                const snapshot = await page.evaluate(
                    pollRealEpubChapterReady,
                    { title, previousRevision, previousAudioUrl, previousAudioSha256,
                        backend },
                );
                if (snapshot && typeof snapshot === 'object' &&
                    snapshot.title === title && snapshot.nav) {
                    return snapshot;
                }
            } catch (error) {
                const message = String(error);
                if (message.includes('Real EPUB reader WAV mismatch')) {
                    const diagnostics = await readReaderNavDiagnostics().catch(() => null);
                    throw Error('Reader chapter readiness failed for ' + title + ': ' +
                        message + '; nav=' + JSON.stringify(diagnostics));
                }
                lastError = error;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const diagnostics = await readReaderNavDiagnostics().catch(() => null);
        throw Error('Reader chapter readiness failed for ' + title + ': ' +
            String(lastError || 'timeout') + '; nav=' + JSON.stringify(diagnostics));
    };
    const first = await waitForChapter('First Chapter');
    const firstExpected = expectedNavForTitle(first.title);
    if (!firstExpected || !first.nav ||
        first.nav.prevDisabled !== firstExpected.prevDisabled ||
        first.nav.nextDisabled !== firstExpected.nextDisabled ||
        first.nav.activeLabel !== 'First Chapter' ||
        first.expectedSpeech !== READER_ACCEPTANCE_SPEECH['First Chapter']) {
        throw Error('EPUB first chapter navigation controls incorrect: ' +
            JSON.stringify({ expected: firstExpected, snapshot: first, nav: first.nav,
                live: await readReaderNavDiagnostics() }));
    }
    await page.locator('#nextChapter').click();
    const second = await waitForChapter(
        'Second Chapter', first.revision, first.audioUrl, first.audioSha256);
    const secondExpected = expectedNavForTitle(second.title);
    if (!secondExpected || !second.nav ||
        second.nav.prevDisabled !== secondExpected.prevDisabled ||
        second.nav.nextDisabled !== secondExpected.nextDisabled ||
        second.nav.activeLabel !== 'Second Chapter' ||
        first.audioUrl === second.audioUrl ||
        first.audioSha256 === second.audioSha256 ||
        second.expectedSpeech !== READER_ACCEPTANCE_SPEECH['Second Chapter']) {
        throw Error('EPUB navigation failed to replace audio or update chapter controls: ' +
            JSON.stringify({ expected: secondExpected, snapshot: second, nav: second.nav,
                firstAudioUrl: first.audioUrl, secondAudioUrl: second.audioUrl,
                firstAudioSha256: first.audioSha256, secondAudioSha256: second.audioSha256,
                live: await readReaderNavDiagnostics() }));
    }
    await page.locator('#nextChapter').click();
    const third = await waitForChapter(
        'Third Chapter', second.revision, second.audioUrl, second.audioSha256);
    const thirdExpected = expectedNavForTitle(third.title);
    if (!thirdExpected || !third.nav ||
        third.nav.prevDisabled !== thirdExpected.prevDisabled ||
        third.nav.nextDisabled !== thirdExpected.nextDisabled ||
        third.nav.activeLabel !== 'Third Chapter' ||
        first.audioUrl === third.audioUrl ||
        second.audioUrl === third.audioUrl ||
        first.audioSha256 === third.audioSha256 ||
        second.audioSha256 === third.audioSha256 ||
        third.expectedSpeech !== READER_ACCEPTANCE_SPEECH['Third Chapter']) {
        throw Error('EPUB third-chapter navigation failed to replace audio or update controls: ' +
            JSON.stringify({ expected: thirdExpected, snapshot: third, nav: third.nav,
                firstAudioUrl: first.audioUrl, secondAudioUrl: second.audioUrl,
                thirdAudioUrl: third.audioUrl,
                firstAudioSha256: first.audioSha256, secondAudioSha256: second.audioSha256,
                thirdAudioSha256: third.audioSha256,
                live: await readReaderNavDiagnostics() }));
    }
    await page.locator('#openAnotherDocument').click();
    await page.locator('#fileInput').setInputFiles({
        name: 'acceptance.txt', mimeType: 'text/plain',
        buffer: Buffer.from(READER_ACCEPTANCE_SPEECH['acceptance.txt'], 'utf8'),
    });
    const plainText = await waitForChapter(
        'acceptance.txt', third.revision, third.audioUrl, third.audioSha256);
    const txtExpected = expectedNavForTitle(plainText.title);
    const differentAudioPerChapter = new Set([
        first.audioSha256, second.audioSha256, third.audioSha256, plainText.audioSha256,
    ]).size === 4;
    if (plainText.audioUrl === third.audioUrl ||
        !differentAudioPerChapter ||
        !txtExpected || !plainText.nav ||
        plainText.nav.prevDisabled !== txtExpected.prevDisabled ||
        plainText.nav.nextDisabled !== txtExpected.nextDisabled ||
        plainText.nav.activeLabel !== 'acceptance.txt' ||
        plainText.nav.entries.length !== 1 ||
        plainText.expectedSpeech !== READER_ACCEPTANCE_SPEECH['acceptance.txt']) {
        throw Error('TXT document replacement retained stale EPUB audio or navigation: ' +
            JSON.stringify({ expected: txtExpected, snapshot: plainText, nav: plainText.nav,
                thirdAudioUrl: third.audioUrl, txtAudioUrl: plainText.audioUrl,
                firstAudioSha256: first.audioSha256, secondAudioSha256: second.audioSha256,
                thirdAudioSha256: third.audioSha256, txtAudioSha256: plainText.audioSha256,
                live: await readReaderNavDiagnostics() }));
    }
    const selected = await page.evaluate(async () =>
        (await chrome.storage.sync.get({ ttsBackend: 'fastapi' })).ttsBackend);
    if (selected !== backend) throw Error('Reader silently switched local TTS backend');
    return {
        success: true, browser: 'Chromium', backend,
        epubFileSelectedThroughUi: true, chapterCount: 3,
        first: { title: first.title, revision: first.revision, audioBytes: first.bytes,
            audioSha256: first.audioSha256, speech: first.expectedSpeech },
        second: { title: second.title, revision: second.revision, audioBytes: second.bytes,
            audioSha256: second.audioSha256, speech: second.expectedSpeech },
        third: { title: third.title, revision: third.revision, audioBytes: third.bytes,
            audioSha256: third.audioSha256, speech: third.expectedSpeech },
        txtReplacement: { title: plainText.title, revision: plainText.revision,
            audioBytes: plainText.bytes, audioSha256: plainText.audioSha256,
            speech: plainText.expectedSpeech },
        local24kHzWav: true, differentAudioPerChapter,
        offline: true, noServerFallback: true, autoplayDisabled: true,
        userBackendUnchanged: true,
    };
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
liveHeartbeat('loopback-model-server-listening');
let context;
try {
    liveHeartbeat('playwright-import-start');
    const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
    const extension = path.resolve('dist/chrome');
    liveHeartbeat('chromium-launch-start', { headed: headedConsent === true });
    context = await withTimeout(chromium.launchPersistentContext(
        path.join(sourceDir, 'profile'), {
            channel: 'chromium', headless: !headedConsent,
            args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
        }), 120000, 'chromium.launchPersistentContext');
    liveHeartbeat('chromium-launch-done');
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
    liveHeartbeat('service-worker-ready');
    const extensionId = new URL(worker.url()).hostname;
    extensionOrigin = 'chrome-extension://' + extensionId;
    const preflightPage = await context.newPage();
    const errors = [];
    preflightPage.on('pageerror', error => errors.push(String(error)));
    liveHeartbeat('preflight-goto-benchmark');
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
    liveHeartbeat('preflight-complete', { browser: preflight.browser });
    // Exercise the production model-data store against its real pinned HTTPS
    // CMUdict URL. This deliberately does not substitute the local loopback
    // transfer used later for heavyweight model inference acceptance.
    liveHeartbeat('dictionary-cache-acceptance-start');
    const dictionaryCacheAcceptance = await withTimeout(preflightPage.evaluate(async () => {
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
    }), 180000, 'dictionary cache acceptance');
    liveHeartbeat('dictionary-cache-acceptance-done', {
        success: dictionaryCacheAcceptance.success === true,
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
    let popupTestTtsCtaAcceptance = null;
    let gpuExecutionDisclosureAcceptance = null;
    let storeSigningDisclosureAcceptance = null;
    let progressiveStreamingTtfaAcceptance = null;
    let twoBackendComparisonAcceptance = null;
    let fastapiServerCardAcceptance = null;
    let fastapiPreferenceHonorAcceptance = null;
    let oovG2pDisclosureAcceptance = null;
    // Optional currentProvider snapshots mid-loop checks that are not yet in
    // `results` (pushed only after all stages for that provider finish).
    const saveReport = (currentProvider = null) => writeFile(
        path.join(resultsDir, 'report.json'), JSON.stringify({
            testedAt: new Date().toISOString(), browser: preflight.browser, preflight,
            dictionaryCacheAcceptance, browserRestartAcceptance,
            dictionaryUiDownloadAcceptance, popupTestTtsCtaAcceptance,
            gpuExecutionDisclosureAcceptance, storeSigningDisclosureAcceptance,
            progressiveStreamingTtfaAcceptance,
            twoBackendComparisonAcceptance, fastapiServerCardAcceptance,
            fastapiPreferenceHonorAcceptance, oovG2pDisclosureAcceptance,
            results, currentProvider, originDownload, providerFilter,
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
        let onnxOverlayAcceptance = null;
        let mediapipeOverlayAcceptance = null;
        let localBenchmarkAcceptance = null;
        let epubReaderAcceptance = null;
        let articleSelectionAcceptance = null;
        let longFormMemoryAcceptance = null;
        const currentProviderSnapshot = () => buildCurrentProviderSnapshot({
            provider: manifest.provider,
            variant: manifest.variant,
            stage,
            crashed,
            originModelAcceptance,
            onnxPlaybackAcceptance,
            onnxOverlayAcceptance,
            mediapipeOverlayAcceptance,
            localBenchmarkAcceptance,
            epubReaderAcceptance,
            articleSelectionAcceptance,
            longFormMemoryAcceptance,
        });
        page.on('pageerror', error => errors.push(String(error)));
        page.on('crash', () => { crashed = true; });
        try {
            await page.goto('chrome-extension://' + extensionId + '/benchmark.html');
            if (originDownload) {
                stage = 'official-origin-download-via-real-model-manager-ui';
                liveHeartbeat(stage, { provider: manifest.provider });
                originModelAcceptance = await downloadModelFromOfficialOrigin(page, manifest);
                liveHeartbeat('official-origin-download-done', {
                    provider: manifest.provider,
                    success: originModelAcceptance?.success === true,
                });
                await saveReport(currentProviderSnapshot());
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
            liveHeartbeat('offline-mode-enter', { provider: manifest.provider });
            await context.setOffline(true);
            if (!await withTimeout(page.evaluate(() => navigator.onLine === false),
                15000, 'navigator.onLine offline check')) {
                throw Error('Chromium did not enter offline mode before inference');
            }
            stage = 'offline-model-initialization-and-synthesis';
            liveHeartbeat(stage, { provider: manifest.provider, variant: manifest.variant });
            await saveReport(currentProviderSnapshot());
            await withTimeout(page.evaluate(({ provider, variant }) => {
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
        }, { provider: manifest.provider, variant: manifest.variant }),
            30000, 'start offline synthesis probe');
            // Node-side deadline: Playwright's waitForFunction timeout may not
            // fire if ONNX/WASM wedges the renderer and CDP polls stop moving.
            liveHeartbeat('offline-synthesis-wait-start', { timeoutMs: 240000 });
            await withTimeout(
                page.waitForFunction(() => window.__kokoroProbe?.done === true, null, {
                    timeout: 240000,
                }),
                250000, 'offline synthesis probe wait');
            liveHeartbeat('offline-synthesis-wait-done');
        const result = await withTimeout(page.evaluate(() => window.__kokoroProbe),
            30000, 'read __kokoroProbe');
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
                onnxPlaybackAcceptance = await page.evaluate(async (oovWord) => {
                    const { AudioManager } = await import('./audio-manager.js');
                    const {
                        discloseOnnxEnglishG2pLimits,
                        listUnsupportedEnglishWords,
                        loadCachedEnglishLexicon,
                    } = await import('./english-g2p.js');
                    const manager = new AudioManager();
                    try {
                        // This is a disposable extension profile; verify the
                        // actual reader queue and storage-selected backend.
                        await chrome.storage.local.set({ pendingTtsBackend: 'onnx', pendingApiUrl: '' });
                        manager.setSentences([
                            { text: 'Hello world.' },
                            { text: oovWord + '.' },
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
                        const disclosure = discloseOnnxEnglishG2pLimits();
                        const lexicon = await loadCachedEnglishLexicon(chrome, caches);
                        const listed = listUnsupportedEnglishWords(oovWord + '.', lexicon);
                        if (!listed.includes(oovWord)) {
                            throw Error('OOV word was not listed as unsupported: ' +
                                JSON.stringify(listed));
                        }
                        if (navigator.onLine !== false) throw Error('ONNX playback was not offline');
                        return { success: true, backend: 'onnx', sampleRateHz, audioBytes,
                            unknownWordsRejected: true, networkOffline: true,
                            oovDisclosure: disclosure, unsupportedListed: listed };
                    } catch (error) {
                        return { success: false, error: String(error),
                            stack: String(error.stack || '') };
                    } finally {
                        manager.clear();
                        if (manager.localProvider) await manager.localProvider.close();
                    }
                }, OOV_PROBE_WORD);
                if (!onnxPlaybackAcceptance.success) {
                    throw Error('Chromium ONNX real reading-path acceptance failed: ' +
                        JSON.stringify(onnxPlaybackAcceptance));
                }
                // KE-41b: strengthen fail-closed with shared dictionary-gated disclosure.
                assertOnnxOovG2pDisclosure({
                    ...onnxPlaybackAcceptance.oovDisclosure,
                    unknownWordsRejected: true,
                });
                oovG2pDisclosureAcceptance = buildOovG2pDisclosureReport({
                    browser: 'chromium',
                    unknownWordsRejected: true,
                    oovProbe: OOV_PROBE_WORD,
                });
                assertOovG2pDisclosureReport(oovG2pDisclosureAcceptance);

                stage = 'offline-onnx-overlay-controls';
                liveHeartbeat(stage, { provider: 'onnx' });
                onnxOverlayAcceptance = await acceptOverlayControls(
                    page, extensionId, 'onnx');
                await saveReport(currentProviderSnapshot());
            }
            if (originDownload && manifest.provider === 'mediapipe' && result.success) {
                stage = 'offline-mediapipe-overlay-controls';
                liveHeartbeat(stage, { provider: 'mediapipe' });
                mediapipeOverlayAcceptance = await acceptOverlayControls(
                    page, extensionId, 'mediapipe');
                await saveReport(currentProviderSnapshot());
            }
            if (originDownload && result.success) {
                stage = 'offline-real-benchmark-page-controls';
                liveHeartbeat(stage, { provider: manifest.provider });
                if (page.isClosed()) {
                    throw Error('Probe page closed before local benchmark UI');
                }
                localBenchmarkAcceptance = await acceptLocalBenchmarkUi(
                    page, extensionId, manifest);
                await saveReport(currentProviderSnapshot());
            }
            if (originDownload && result.success &&
                (manifest.provider === 'onnx' || manifest.provider === 'mediapipe')) {
                stage = 'offline-real-epub-chapters-and-txt-reader';
                liveHeartbeat(stage, { provider: manifest.provider });
                epubReaderAcceptance = await acceptRealEpubReader(
                    page, extensionId, manifest.provider);
                liveHeartbeat('epub-reader-done', {
                    success: epubReaderAcceptance?.success === true,
                });
                await saveReport(currentProviderSnapshot());
            }
            if (originArticleSelectionStageEnabled(
                originDownload, manifest.provider, result.success)) {
                stage = 'offline-real-article-and-selection';
                liveHeartbeat(stage, { provider: manifest.provider });
                articleSelectionAcceptance = await acceptRealArticleAndSelection(
                    page, context, extensionId, manifest.provider);
                liveHeartbeat('article-selection-done', {
                    success: articleSelectionAcceptance?.success === true,
                });
                await saveReport(currentProviderSnapshot());
            }
            if (originLongFormMemoryStageEnabled(
                originDownload, manifest.provider, result.success)) {
                stage = 'offline-real-long-form-memory';
                liveHeartbeat(stage, { provider: manifest.provider });
                longFormMemoryAcceptance = await acceptLongFormMemoryPerformance(
                    page, context, extensionId, manifest.provider);
                liveHeartbeat('long-form-memory-done-stage', {
                    success: longFormMemoryAcceptance?.success === true,
                    maxCacheSize: longFormMemoryAcceptance?.maxCacheSize,
                });
                await saveReport(currentProviderSnapshot());
            }
            console.log(result.success ? 'REAL MODEL INFERENCE' : 'MODEL INFERENCE FAILURE', result);
            results.push({ provider: manifest.provider, variant: manifest.variant,
                offlineAttempted: true, offlineInference: result.success === true,
                originModelAcceptance, onnxPlaybackAcceptance, onnxOverlayAcceptance,
                mediapipeOverlayAcceptance,
                localBenchmarkAcceptance, epubReaderAcceptance,
                articleSelectionAcceptance, longFormMemoryAcceptance, ...result });
            await saveReport();
        } catch (error) {
            liveHeartbeat('provider-validation-aborted', {
                stage, error: String(error).slice(0, 240),
            });
            const failure = { provider: manifest.provider, variant: manifest.variant,
                success: false, crashed, stage, originModelAcceptance,
                onnxPlaybackAcceptance, onnxOverlayAcceptance,
                mediapipeOverlayAcceptance,
                localBenchmarkAcceptance, epubReaderAcceptance,
                articleSelectionAcceptance, longFormMemoryAcceptance,
                error: String(error) };
            results.push(failure);
            await saveReport();
            console.error('MODEL VALIDATION ABORTED', failure);
            throw error;
        } finally {
            // Restore network only for the next verified local model transfer.
            // Each provider's acceptance itself must finish entirely offline.
            await context.setOffline(false).catch(() => {});
            if (!page.isClosed()) {
                await withTimeout(page.close(), 15000, 'page.close after provider')
                    .catch((closeError) => liveHeartbeat('page-close-timeout', {
                        error: String(closeError).slice(0, 160),
                    }));
            }
        }
    }
    if (errors.length) throw Error('Extension errors: ' + errors.join('; '));
    if (results.some(result => !result.success)) {
        throw Error('One or more actual model integrations failed: see attached report.json');
    }

    if (providerFilter === 'both' && !originDownload) {
        // #61 / KE-41a: adapter presence ≠ offered/measured GPU inference.
        // Assert against the real preflight JSON before dual stages proceed.
        liveHeartbeat('gpu-execution-disclosure-start');
        const {
            assertGpuExecutionDisclosure,
            buildGpuExecutionDisclosureReport,
        } = await import('./gpu-execution-disclosure-acceptance.mjs');
        const assertedGpu = assertGpuExecutionDisclosure(preflight);
        gpuExecutionDisclosureAcceptance = buildGpuExecutionDisclosureReport({
            browser: 'chromium',
            webgpuAdapterStatus: assertedGpu.webgpuAdapterStatus,
            assertedFromPreflight: true,
        });
        liveHeartbeat('gpu-execution-disclosure-done', {
            success: gpuExecutionDisclosureAcceptance?.success === true,
            webgpuAdapterStatus:
                gpuExecutionDisclosureAcceptance?.webgpuAdapterStatus,
        });
        await saveReport();

        // #61 popup CTA before dual comparison (extension pages; network optional).
        try {
            liveHeartbeat('popup-test-tts-cta-start');
            popupTestTtsCtaAcceptance = await acceptPopupTestTtsCta(
                context, extensionId);
            liveHeartbeat('popup-test-tts-cta-done', {
                success: popupTestTtsCtaAcceptance?.success === true,
            });
            await saveReport();
        } catch (error) {
            popupTestTtsCtaAcceptance = {
                success: false,
                stage: 'popup-test-tts-cta',
                error: String(error),
            };
            await saveReport();
            throw error;
        }
        // Reuse both pinned, checksum-verified model caches in one renderer,
        // with HTTP(S) disabled. Runtime memory must be freed after each test
        // while the first provider's measurement stays visible.
        const comparisonPage = await context.newPage();
        comparisonPage.on('pageerror', error => errors.push(String(error)));
        await context.setOffline(true);
        try {
            twoBackendComparisonAcceptance = await acceptTwoBackendComparison(
                comparisonPage, extensionId);
            if (twoBackendComparisonAcceptance?.oovG2pDisclosureAcceptance) {
                oovG2pDisclosureAcceptance =
                    twoBackendComparisonAcceptance.oovG2pDisclosureAcceptance;
            }
            // #61 / KE-46: store signing must come from the verified measured
            // export payload (not a hard-coded honesty stub).
            liveHeartbeat('store-signing-disclosure-start');
            storeSigningDisclosureAcceptance =
                twoBackendComparisonAcceptance?.measuredResultsExport
                    ?.storeSigningDisclosureAcceptance || null;
            if (storeSigningDisclosureAcceptance?.assertedFromExport !== true ||
                storeSigningDisclosureAcceptance?.success !== true) {
                throw Error(
                    'Store signing disclosure missing verified export evidence: ' +
                    JSON.stringify(storeSigningDisclosureAcceptance));
            }
            liveHeartbeat('store-signing-disclosure-done', {
                success: storeSigningDisclosureAcceptance?.success === true,
                storePackagesSigned:
                    storeSigningDisclosureAcceptance?.storePackagesSigned,
                storeSigningMeasured:
                    storeSigningDisclosureAcceptance?.storeSigningMeasured,
                assertedFromExport:
                    storeSigningDisclosureAcceptance?.assertedFromExport,
            });
            if (errors.length) throw Error('Extension errors during two-backend comparison: ' +
                errors.join('; '));
            await saveReport();

            // Local dual must leave the server card untested; FastAPI card
            // needs a brief online window + loopback /v1/audio/speech stub.
            liveHeartbeat('fastapi-server-card-start');
            await context.setOffline(false);
            const speechStub = await startFastApiSpeechStub();
            try {
                fastapiServerCardAcceptance = await acceptFastApiServerCard(
                    comparisonPage, speechStub.apiUrl);
                progressiveStreamingTtfaAcceptance =
                    fastapiServerCardAcceptance
                        ?.progressiveStreamingTtfaAcceptance || null;
                if (progressiveStreamingTtfaAcceptance?.assertedFromServerCard !==
                        true ||
                    progressiveStreamingTtfaAcceptance?.success !== true ||
                    progressiveStreamingTtfaAcceptance
                        ?.progressiveStreamingTtfaMeasured !== false ||
                    progressiveStreamingTtfaAcceptance
                        ?.trueMediaSourceTtfaMeasured !== false) {
                    throw Error(
                        'Progressive MediaSource TTFA unmeasured acceptance ' +
                        'missing verified server-card evidence: ' +
                        JSON.stringify(progressiveStreamingTtfaAcceptance));
                }
                liveHeartbeat('fastapi-server-card-done', {
                    success: fastapiServerCardAcceptance?.success === true,
                    progressiveStreamingTtfaMeasured:
                        progressiveStreamingTtfaAcceptance
                            ?.progressiveStreamingTtfaMeasured,
                    trueMediaSourceTtfaMeasured:
                        progressiveStreamingTtfaAcceptance
                            ?.trueMediaSourceTtfaMeasured,
                });
                await saveReport();
                liveHeartbeat('fastapi-preference-honor-start');
                fastapiPreferenceHonorAcceptance =
                    await acceptFastApiPreferenceHonor(
                        context, extensionId, speechStub);
                liveHeartbeat('fastapi-preference-honor-done', {
                    success:
                        fastapiPreferenceHonorAcceptance?.success === true,
                });
                await saveReport();
            } finally {
                await speechStub.close().catch(() => {});
            }
        } catch (error) {
            if (!twoBackendComparisonAcceptance ||
                twoBackendComparisonAcceptance.success !== true) {
                twoBackendComparisonAcceptance = { success: false,
                    stage: 'offline-two-backend-same-page-benchmark',
                    error: String(error) };
            } else if (!fastapiServerCardAcceptance ||
                fastapiServerCardAcceptance.success !== true) {
                fastapiServerCardAcceptance = { success: false,
                    stage: 'fastapi-server-card',
                    error: String(error) };
            } else if (!fastapiPreferenceHonorAcceptance ||
                fastapiPreferenceHonorAcceptance.success !== true) {
                fastapiPreferenceHonorAcceptance = { success: false,
                    stage: 'fastapi-preference-honor',
                    error: String(error) };
            }
            await saveReport();
            throw error;
        } finally {
            await context.setOffline(false);
            if (!comparisonPage.isClosed()) await comparisonPage.close();
        }
    }

    // The persistent Chromium profile is reused across an actual browser
    // process shutdown/startup. No network model re-download may be needed.
    liveHeartbeat('chromium-close-before-restart');
    await withTimeout(context.close(), 30000, 'context.close before restart')
        .catch((closeError) => liveHeartbeat('chromium-close-before-restart-timeout', {
            error: String(closeError).slice(0, 160),
        }));
    context = null;
    liveHeartbeat('chromium-relaunch-after-restart-start');
    context = await withTimeout(chromium.launchPersistentContext(
        path.join(sourceDir, 'profile'), {
            channel: 'chromium', headless: !headedConsent,
            args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
        }), 120000, 'chromium.launchPersistentContext (restart)');
    liveHeartbeat('chromium-relaunch-after-restart-done');
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
    clearInterval(aliveTimer);
    liveHeartbeat('harness-teardown');
    if (context) {
        await withTimeout(context.close(), 20000, 'context.close')
            .catch((closeError) => liveHeartbeat('context-close-timeout', {
                error: String(closeError).slice(0, 160),
            }));
    }
    await new Promise(resolve => server.close(resolve));
}
