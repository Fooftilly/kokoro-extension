// Selenium executes this script INSIDE the packaged Firefox extension page.
// Unlike a simulated quota error, ModelDataStore and Cache Storage remain real.
// Two calls in separate browser processes use exactly the same deterministic
// synthetic asset digests; no model weights or official URLs are fetched.
async function checkLimitedQuota({ store, dictionary, onnx, calls, summary }) {
        await store.remove(onnx);
        await store.remove(dictionary);
        // Separate protected provider: no model download is triggered by merely
        // checking status or the quota-estimate UI.
        if ((await store.status(onnx)).ready || calls.length) {
            throw Error('Unexpected implicit fixture download');
        }
        await store.install(dictionary); // Explicit deterministic seed.
        const protectedBefore = await store.verifyAndPruneCorrupt(dictionary);
        if (!protectedBefore.ready || protectedBefore.removedAssets) {
            throw Error('Failed to seed independent dictionary fixture');
        }
        let failure = null;
        try {
            await store.install(onnx); // Real Firefox Cache API + quota manager.
        } catch (error) {
            failure = { name: error.name, message: String(error.message || error) };
        }
        const model = await store.status(onnx);
        const verified = await store.verifyAndPruneCorrupt(onnx);
        const dictionaryAfter = await store.verifyAndPruneCorrupt(dictionary);
        Object.assign(summary, {
            failure, model, verified, calls,
            dictionaryPreserved: dictionaryAfter.ready &&
                dictionaryAfter.removedAssets === 0,
        });
        const reason = [failure?.name, failure?.message].join(' ');
        if (!failure || !/quota|space|NS_ERROR_DOM_QUOTA_REACHED/i.test(reason) ||
            model.ready || model.storedBytes !== onnx.assets[0].bytes ||
            verified.verifiedBytes !== onnx.assets[0].bytes ||
            verified.missingAssets !== 1 || verified.removedAssets !== 0 ||
            !summary.dictionaryPreserved || calls.length !== 3 ||
            calls[0] !== dictionary.assets[0].url ||
            calls[1] !== onnx.assets[0].url ||
            calls[2] !== onnx.assets[1].url) {
            throw Error('Actual Firefox quota rejection failed to preserve the ' +
                'first asset and independent dictionary: ' + JSON.stringify(summary));
        }
}

async function checkRecoveredQuota({ store, dictionary, onnx, calls, summary }) {
        const prior = await store.status(onnx);
        const dictionaryBefore = await store.verifyAndPruneCorrupt(dictionary);
        if (prior.ready || prior.storedBytes !== onnx.assets[0].bytes ||
            !dictionaryBefore.ready || dictionaryBefore.removedAssets) {
            throw Error('Partial model or dictionary was lost across Firefox restart');
        }
        if (calls.length) throw Error('Status/verification implicitly fetched a model');
        await store.install(onnx); // Only explicit retry may fetch missing voice.
        const model = await store.verifyAndPruneCorrupt(onnx);
        const status = await store.status(onnx);
        const protectedAfter = await store.verifyAndPruneCorrupt(dictionary);
        if (!model.ready || model.removedAssets || model.missingAssets ||
            !status.ready || status.storedBytes !== summary.modelBytes ||
            !protectedAfter.ready || protectedAfter.removedAssets ||
            calls.length !== 1 || calls[0] !== onnx.assets[1].url) {
            throw Error('Firefox explicit second-asset retry or SHA-256 failed: ' +
                JSON.stringify({ model, status, protectedAfter, calls }));
        }
        await store.remove(onnx);
        const removed = await store.status(onnx);
        const otherStillReady = await store.verifyAndPruneCorrupt(dictionary);
        if (removed.ready || removed.storedBytes !== 0 ||
            !otherStillReady.ready || otherStillReady.removedAssets || 
            calls.length !== 1) {
            throw Error('Firefox Remove damaged dictionary or fetched model data');
        }
        Object.assign(summary, {
            firstAssetPreservedAcrossRestart: true,
            explicitRetryFetchedOnlyMissingVoice: true,
            installedVerified: true,
            otherProviderUnchanged: true,
            removedOnlySelectedModel: true, calls,
        });
}

globalThis.runFirefoxQuotaProbe = async phase => {
    const { ModelDataStore, validateModelManifest } =
        await import('./model-data-store.js');
    const revision = 'b'.repeat(40);
    const calls = [];
    const samples = new Map();
    const makeAsset = async (path, url, count, seed) => {
        const bytes = new Uint8Array(count);
        // High-entropy but reproducible: compression cannot make the 5 MiB
        // voice fixture appear small enough to fit an 8 MiB global cap.
        let value = seed >>> 0;
        for (let i = 0; i < count; i++) {
            value ^= value << 13;
            value ^= value >>> 17;
            value ^= value << 5;
            bytes[i] = value & 255;
        }
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
        const integrity = 'sha256-' + globalThis.btoa(String.fromCharCode(...digest));
        samples.set(url, bytes);
        return { path, url, bytes: count, integrity };
    };
    const dictionary = {
        provider: 'dictionary', revision, variant: 'english',
        assets: [await makeAsset('cmudict.dict',
            'https://raw.githubusercontent.com/cmusphinx/cmudict/' +
            revision + '/cmudict.dict', 16384, 0xfeed1234)],
    };
    const base = 'https://huggingface.co/onnx-community/' +
        'Kokoro-82M-v1.0-ONNX/resolve/' + revision + '/';
    const onnx = {
        provider: 'onnx', revision, variant: 'q8',
        assets: [
            await makeAsset('onnx/model_quantized.onnx',
                base + 'onnx/model_quantized.onnx', 98304, 0x13579bdf),
            await makeAsset('voices/af.bin',
                base + 'voices/af.bin', 16777216, 0xabcdef17),
        ],
    };
    validateModelManifest(dictionary);
    validateModelManifest(onnx);
    const store = new ModelDataStore({
        origin: globalThis.browser.runtime.getURL('/'), cacheStorage: globalThis.caches,
        fetchImpl: async url => {
            const bytes = samples.get(url);
            if (!bytes) throw Error('Unpinned fixture URL: ' + url);
            calls.push(url);
            return new globalThis.Response(bytes, { status: 200 });
        },
        responseClass: globalThis.Response, streamClass: globalThis.TransformStream,
    });
    const estimate = await globalThis.navigator.storage.estimate();
    if (!Number.isFinite(estimate?.quota) || !Number.isFinite(estimate?.usage)) {
        throw Error('Firefox did not expose an actual StorageManager quota estimate');
    }
    const summary = {
        phase, storageEstimate: { usage: estimate.usage, quota: estimate.quota },
        modelBytes: onnx.assets.reduce((sum, asset) => sum + asset.bytes, 0),
        protectedBytes: dictionary.assets[0].bytes,
    };
    // This *global* Firefox QuotaManager cap is different from the per-origin
    // navigator.storage.estimate() quota. Require the synthetic installation
    // to exceed the configured global cap before attempting quota enforcement.
    const limitedGlobalCapBytes = 8192 * 1024;
    summary.limitedGlobalCapBytes = limitedGlobalCapBytes;
    if (phase === 'limited' && summary.modelBytes <= limitedGlobalCapBytes) {
        throw Error('Quota fixture too small to exceed Firefox global cap: ' +
            JSON.stringify(summary));
    }
    const context = { store, dictionary, onnx, calls, summary };
    if (phase === 'limited') {
        await checkLimitedQuota(context);
    } else if (phase === 'recovery') {
        await checkRecoveredQuota(context);
    } else {
        throw Error('Unknown Firefox quota acceptance phase: ' + phase);
    }
    return summary;
};
