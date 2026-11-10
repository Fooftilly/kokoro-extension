// Manual browser-quota acceptance: real Chromium Cache Storage + quota manager.
// Uses bounded synthetic data and pinned-shaped local fixtures, not model weights.
// No model-host access, remote code, or automatic installation is required.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.KOKORO_LIVE_DOWNLOAD !== '1' ||
    process.env.KOKORO_CHROMIUM_QUOTA_ACCEPTANCE !== '1' ||
    !process.env.PLAYWRIGHT_MODULE_PATH) {
    throw Error('Manual quota mode, model-test opt-in, and pinned Playwright path required');
}

const reportDir = path.resolve('dist/runtime-acceptance');
await mkdir(reportDir, { recursive: true });
const outputFile = path.join(reportDir, 'chromium-quota.json');
const profile = await mkdtemp(path.join(os.tmpdir(), 'kokoro-quota-'));
const report = {
    status: 'started', browser: 'Chromium MV3', mode: 'real-origin-quota',
    modelWeightsDownloaded: false, syntheticFixtureOnly: true,
    networkOfflineDuringQuotaProbe: false, browserQuotaEnforced: false,
    actualBrowserEvictionObserved: false,
};
let context;
let session;
let origin;
let quotaActive = false;
try {
    const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
    const extension = path.resolve('dist/chrome');
    context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true,
        args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
    });
    const worker = context.serviceWorkers()[0] ||
        await context.waitForEvent('serviceworker', { timeout: 30000 });
    const extensionId = new URL(worker.url()).hostname;
    origin = 'chrome-extension://' + extensionId;
    const page = await context.newPage();
    await page.goto(origin + '/benchmark.html');
    await page.waitForFunction(() => Boolean(window.KokoroBenchmark));
    session = await context.newCDPSession(page);

    // The pinned-shaped manifests validate origin/asset path restrictions, but
    // only in-memory byte fixtures are returned by the scoped fetchImpl.
    // Browser Cache Storage, WebCrypto, quota enforcement and locks are real.
    const initial = await page.evaluate(async () => {
        const { ModelDataStore, validateModelManifest } =
            await import('./model-data-store.js');
        const revision = 'b'.repeat(40);
        const samples = new Map();
        const calls = [];
        const asset = async (path, url, size, fill) => {
            const bytes = new Uint8Array(size);
            bytes.fill(fill);
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            const integrity = 'sha256-' + btoa(String.fromCharCode(...hash));
            samples.set(url, bytes);
            return { path, url, bytes: size, integrity };
        };
        const dictionary = {
            provider: 'dictionary', revision, variant: 'english',
            assets: [await asset('cmudict.dict',
                'https://raw.githubusercontent.com/cmusphinx/cmudict/' +
                revision + '/cmudict.dict', 16384, 7)],
        };
        const base = 'https://huggingface.co/onnx-community/' +
            'Kokoro-82M-v1.0-ONNX/resolve/' + revision + '/';
        const onnx = {
            provider: 'onnx', revision, variant: 'q8',
            assets: [
                await asset('onnx/model_quantized.onnx',
                    base + 'onnx/model_quantized.onnx', 65536, 19),
                await asset('voices/af.bin', base + 'voices/af.bin', 2097152, 31),
            ],
        };
        validateModelManifest(dictionary);
        validateModelManifest(onnx);
        const store = new ModelDataStore({
            origin: chrome.runtime.getURL('/'), cacheStorage: caches,
            fetchImpl: async url => {
                const bytes = samples.get(url);
                if (!bytes) throw Error('Unexpected fixture URL: ' + url);
                calls.push(url);
                return new Response(bytes, { status: 200 });
            },
            responseClass: Response, streamClass: TransformStream,
        });
        await store.remove(dictionary);
        await store.remove(onnx);
        await store.install(dictionary); // Independently retained provider.
        const protectedStatus = await store.verifyAndPruneCorrupt(dictionary);
        if (!protectedStatus.ready || protectedStatus.removedAssets) {
            throw Error('Could not seed checksum-verified protected dictionary fixture');
        }
        globalThis.__quotaFixture = { store, dictionary, onnx, calls };
        return {
            protectedBytes: protectedStatus.verifiedBytes,
            firstAssetBytes: onnx.assets[0].bytes,
            secondAssetBytes: onnx.assets[1].bytes,
            manifestBytes: onnx.assets.reduce((sum, item) => sum + item.bytes, 0),
        };
    });
    report.fixture = initial;

    // CDP modifies the browser's actual quota manager. This is not a mocked
    // Cache.put exception, a manual cache.delete or a storage.estimate stub.
    let before;
    try {
        before = await session.send('Storage.getUsageAndQuota', { origin });
    } catch (error) {
        throw Error('Chromium cannot inspect extension-origin quota via CDP: ' + error);
    }
    if (!Number.isFinite(before.usage) || !Number.isFinite(before.quota) ||
        before.quota <= before.usage) {
        throw Error('Chromium quota response is unsupported/inconsistent: ' +
            JSON.stringify(before));
    }
    const cappedBytes = Math.ceil(before.usage) + 524288;
    if (cappedBytes >= before.quota) {
        throw Error('Existing browser quota is already below the test cap');
    }
    report.quotaBefore = before;
    await session.send('Storage.overrideQuotaForOrigin', {
        origin, quotaSize: cappedBytes,
    });
    quotaActive = true;
    const enforced = await session.send('Storage.getUsageAndQuota', { origin });
    if (!enforced.overrideActive || Math.abs(enforced.quota - cappedBytes) > 1) {
        throw Error('Browser did not activate an effective extension-origin quota: ' +
            JSON.stringify(enforced));
    }
    report.quotaDuring = enforced;
    await context.setOffline(true);
    if (!await page.evaluate(() => navigator.onLine === false)) {
        throw Error('Chromium did not enter network-offline mode for quota acceptance');
    }
    report.networkOfflineDuringQuotaProbe = true;

    const failedAttempt = await page.evaluate(async () => {
        const fixture = globalThis.__quotaFixture;
        const { store, onnx, dictionary, calls } = fixture;
        let failure = null;
        try {
            await store.install(onnx);
        } catch (error) {
            failure = { name: error.name, message: String(error.message || error) };
        }
        const model = await store.status(onnx);
        const verified = await store.verifyAndPruneCorrupt(onnx);
        const protectedCheck = await store.verifyAndPruneCorrupt(dictionary);
        return { failure, model, verified,
            protectedReady: protectedCheck.ready && !protectedCheck.removedAssets,
            requests: [...calls] };
    });
    report.quotaFailure = failedAttempt;
    if (!failedAttempt.failure ||
        !/quota|space|storage/i.test(failedAttempt.failure.name + ' ' +
            failedAttempt.failure.message) ||
        failedAttempt.model.ready ||
        failedAttempt.model.storedBytes !== initial.firstAssetBytes ||
        failedAttempt.verified.verifiedBytes !== initial.firstAssetBytes ||
        failedAttempt.verified.missingAssets !== 1 ||
        failedAttempt.verified.removedAssets !== 0 ||
        !failedAttempt.protectedReady ||
        failedAttempt.requests.length !== 3) {
        throw Error('Real quota enforcement did not preserve first asset and other ' +
            'provider while rejecting second asset: ' + JSON.stringify(failedAttempt));
    }
    report.browserQuotaEnforced = true;

    // Only after quota is restored does an explicit retry occur. The valid
    // graph is re-hashed/reused, while the missing voice alone is re-fetched.
    await session.send('Storage.overrideQuotaForOrigin', { origin });
    quotaActive = false;
    const restored = await session.send('Storage.getUsageAndQuota', { origin });
    if (restored.overrideActive) throw Error('Browser did not reset the quota override');
    report.quotaRestored = restored;

    const retry = await page.evaluate(async () => {
        const { store, onnx, dictionary, calls } = globalThis.__quotaFixture;
        const beforeCalls = [...calls];
        const partial = await store.status(onnx);
        if (partial.ready) throw Error('ONNX fixture was implicitly repaired');
        await store.install(onnx); // Explicit second attempt only.
        const model = await store.verifyAndPruneCorrupt(onnx);
        const dictionaryCheck = await store.verifyAndPruneCorrupt(dictionary);
        const installed = await store.status(onnx);
        const allCalls = [...calls];
        await store.remove(onnx); // Must not remove another provider.
        const removed = await store.status(onnx);
        const dictionaryAfterRemoval = await store.verifyAndPruneCorrupt(dictionary);
        return { beforeCalls, allCalls, model, installed, removed,
            dictionaryPreserved: dictionaryCheck.ready && dictionaryAfterRemoval.ready &&
                !dictionaryCheck.removedAssets && !dictionaryAfterRemoval.removedAssets };
    });
    report.explicitRetry = retry;
    if (!retry.model.ready || retry.model.removedAssets !== 0 ||
        retry.installed.storedBytes !== initial.manifestBytes ||
        retry.removed.ready || retry.removed.storedBytes !== 0 ||
        !retry.dictionaryPreserved ||
        retry.beforeCalls.length !== 3 || retry.allCalls.length !== 4) {
        throw Error('Explicit retry or cross-provider preservation failed: ' +
            JSON.stringify(retry));
    }
    // Recorded request order must be dictionary, graph, voice, voice.
    if (retry.allCalls[0] === retry.allCalls[1] ||
        retry.allCalls[1] === retry.allCalls[2] ||
        retry.allCalls[2] !== retry.allCalls[3]) {
        throw Error('Retry re-downloaded a valid first asset: ' +
            JSON.stringify(retry.allCalls));
    }
    await page.evaluate(async () => {
        const { store, dictionary } = globalThis.__quotaFixture;
        await store.remove(dictionary);
        delete globalThis.__quotaFixture;
    });
    report.status = 'passed';
    console.log('CHROMIUM REAL-QUOTA ACCEPTANCE', JSON.stringify(report));
} catch (error) {
    report.status = 'failed';
    report.error = String(error?.stack || error);
    throw error;
} finally {
    if (quotaActive && session && origin) {
        try {
            await session.send('Storage.overrideQuotaForOrigin', { origin });
        } catch (error) {
            report.quotaResetError = String(error);
        }
    }
    await writeFile(outputFile, JSON.stringify(report, null, 2));
    if (context) await context.close();
    await rm(profile, { recursive: true, force: true });
}
