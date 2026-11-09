import { withModelDataLock } from './model-data-lock.js';

// Original, extension-origin model data cache. No automatic model downloads.
// Executable SDK JS/WASM must be shipped with the extension, never fetched here.
// Cache API request keys must have HTTP(S) schemes even in extension-owned caches.
// This reserved .invalid URL is never fetched; Cache Storage is scoped to the extension origin.
const CACHE_KEY_ORIGIN = 'https://kokoro-model-cache.invalid/';
const CACHE_NAME = 'kokoro-model-data-v1';
const ALLOWED_PROVIDERS = Object.freeze(['mediapipe', 'onnx', 'dictionary']);
const INTEGRITY_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const PATH_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const DATA_EXTENSIONS = Object.freeze([
    '.onnx', '.bin', '.json', '.litertlm', '.txt', '.model', '.vocab',
    '.dat', '.fst', '.tflite', '.weights', '.npy', '.dict',
]);
const OFFICIAL_REPOSITORIES = Object.freeze({
    mediapipe: 'litert-community/Kokoro-82M',
    onnx: 'onnx-community/Kokoro-82M-v1.0-ONNX',
});

function officialAssetUrl(manifest, asset) {
    let url;
    try {
        url = new URL(asset.url);
    } catch {
        throw new TypeError('Model data URL must be a valid pinned HTTPS URL');
    }
    if (manifest.provider === 'dictionary') {
        const path = '/cmusphinx/cmudict/' + manifest.revision + '/' + asset.path;
        if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' ||
            url.pathname !== path || asset.path !== 'cmudict.dict' ||
            url.username || url.password || url.port || url.search || url.hash) {
            throw new TypeError('Dictionary data must match the pinned official CMUdict source');
        }
        return;
    }
    const expectedPath = '/' + OFFICIAL_REPOSITORIES[manifest.provider] +
        '/resolve/' + manifest.revision + '/' + asset.path;
    if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' ||
        url.username || url.password || url.search || url.hash || url.port ||
        url.pathname !== expectedPath) {
        throw new TypeError('Model data must match its pinned official repository and asset path');
    }
}

export function validateModelManifest(manifest) {
    if (!manifest || !ALLOWED_PROVIDERS.includes(manifest.provider) ||
        !/^[a-z0-9-]+$/.test(manifest.variant || '') ||
        !SHA_PATTERN.test(manifest.revision || '') ||
        !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
        throw new TypeError('Invalid pinned model manifest');
    }
    const seen = new Set();
    let total = 0;
    for (const asset of manifest.assets) {
        if (!asset || typeof asset.path !== 'string' ||
            !PATH_PATTERN.test(asset.path) ||
            asset.path.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
            seen.has(asset.path) ||
            !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 ||
            !INTEGRITY_PATTERN.test(asset.integrity || '') ||
            !DATA_EXTENSIONS.some(extension => asset.path.endsWith(extension))) {
            throw new TypeError('Invalid, non-data, or duplicate model asset');
        }
        officialAssetUrl(manifest, asset);
        total += asset.bytes;
        if (!Number.isSafeInteger(total)) {
            throw new RangeError('Model size exceeds safe integer range');
        }
        seen.add(asset.path);
    }
    return total;
}

export function formatModelSize(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new TypeError('Invalid byte count');
    }
    return (bytes / 1000000).toFixed(1) + ' MB';
}

// The StorageManager estimate is an approximate origin quota, not a disk-space
// reservation. A shortage is advisory: browsers can evict other data or adjust
// their quotas between this check and Cache Storage's write.
export function assessStorageHeadroom(requiredBytes, estimate) {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
        throw new TypeError('Invalid model download byte count');
    }
    const quota = estimate?.quota;
    const usage = estimate?.usage;
    if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(usage) ||
        quota < 0 || usage < 0) {
        return null;
    }
    const availableBytes = Math.max(0, quota - usage);
    return {
        requiredBytes, availableBytes,
        insufficient: requiredBytes > availableBytes,
    };
}

export class ModelDataStore {
    constructor({ origin, cacheStorage, fetchImpl, responseClass, streamClass,
        lockManager = globalThis.navigator?.locks, subtleCrypto = globalThis.crypto?.subtle }) {
        if (!origin || !cacheStorage || typeof cacheStorage.open !== 'function' ||
            typeof fetchImpl !== 'function' || !responseClass || !streamClass) {
            throw new TypeError('An extension origin and browser APIs are required');
        }
        const parsed = new URL(origin);
        if (!['chrome-extension:', 'moz-extension:'].includes(parsed.protocol)) {
            throw new TypeError('Model cache keys must belong to the extension origin');
        }
        this.origin = parsed.href.endsWith('/') ? parsed.href : parsed.href + '/';
        this.cacheStorage = cacheStorage;
        this.fetchImpl = fetchImpl;
        this.ResponseClass = responseClass;
        this.TransformStreamClass = streamClass;
        this.lockManager = lockManager;
        this.subtleCrypto = subtleCrypto;
    }

    key(manifest, asset) {
        return new URL('model-data/' + manifest.provider + '/' + manifest.revision +
            '/' + manifest.variant + '/' + asset.path, CACHE_KEY_ORIGIN).href;
    }

    async status(manifest) {
        const totalBytes = validateModelManifest(manifest);
        const cache = await this.cacheStorage.open(CACHE_NAME);
        let storedBytes = 0;
        for (const asset of manifest.assets) {
            const existing = await cache.match(this.key(manifest, asset));
            if (this.isCurrent(existing, asset)) storedBytes += asset.bytes;
        }
        return { ready: storedBytes === totalBytes, storedBytes, totalBytes };
    }

    isCurrent(response, asset) {
        return !!response && response.headers.get('x-kokoro-integrity') === asset.integrity &&
            response.headers.get('x-kokoro-bytes') === String(asset.bytes);
    }

    async install(manifest, { signal, onProgress } = {}) {
        return withModelDataLock(async () => {
            const totalBytes = validateModelManifest(manifest);
            const cache = await this.cacheStorage.open(CACHE_NAME);
            let completedBytes = 0;
            // Explicit callers initiate this method only after a user clicked Download.
            // There is no auto-start, and no sent speech text or executable code.
            for (const asset of manifest.assets) {
                if (signal && signal.aborted) throw new DOMException('Download aborted', 'AbortError');
                const key = this.key(manifest, asset);
                if (this.isCurrent(await cache.match(key), asset)) {
                    completedBytes += asset.bytes;
                    if (onProgress) onProgress({ completedBytes, totalBytes });
                    continue;
                }
                await cache.delete(key);
                const response = await this.fetchImpl(asset.url, {
                    signal, cache: 'no-store', integrity: asset.integrity,
                });
                if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError');
                if (!response.ok || response.type === 'opaque' || !response.body) {
                    throw new Error('Unable to download model data through CORS');
                }
                let received = 0;
                const bytesBefore = completedBytes;
                const stream = response.body.pipeThrough(new this.TransformStreamClass({
                    transform(chunk, controller) {
                        if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError');
                        received += chunk.byteLength;
                        if (received > asset.bytes) {
                            throw new Error('Downloaded asset exceeds verified size');
                        }
                        controller.enqueue(chunk);
                        if (onProgress) {
                            onProgress({ completedBytes: bytesBefore + received, totalBytes });
                        }
                    },
                }));
                const headers = {
                    'content-type': 'application/octet-stream',
                    'x-kokoro-integrity': asset.integrity,
                    'x-kokoro-bytes': String(asset.bytes),
                };
                try {
                    await cache.put(key, new this.ResponseClass(stream, { headers }));
                    // Cache Storage can finish committing even after the user clicks
                    // Cancel. A late abort must roll back that write, not report the
                    // model as installed or leave an apparently complete cache entry.
                    if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError');
                    if (received !== asset.bytes) {
                        throw new Error('Downloaded asset length disagrees with pinned manifest');
                    }
                    completedBytes += received;
                } catch (error) {
                    await cache.delete(key);
                    throw error;
                }
            }
            return { ready: true, storedBytes: completedBytes, totalBytes };
        }, { signal, lockManager: this.lockManager });
    }

    // User-initiated repair only. Existing Cache Storage headers describe what
    // was verified during download, but cannot prove that cached bytes are still
    // intact. WebCrypto hashes one full asset at a time and may temporarily use
    // memory comparable to that asset's size (up to ~295 MB for MediaPipe).
    // Hashing failure does NOT imply corruption; never evict on a crypto error.
    async verifyAndPruneCorrupt(manifest, { signal, onProgress } = {}) {
        return withModelDataLock(async () => {
            const totalBytes = validateModelManifest(manifest);
            if (typeof this.subtleCrypto?.digest !== 'function') {
                throw new Error('This browser does not support SHA-256 cache verification');
            }
            const cache = await this.cacheStorage.open(CACHE_NAME);
            let verifiedBytes = 0;
            let removedAssets = 0;
            let missingAssets = 0;
            for (const asset of manifest.assets) {
                if (signal?.aborted) throw new DOMException('Verification cancelled', 'AbortError');
                const key = this.key(manifest, asset);
                const cached = await cache.match(key);
                if (!cached) {
                    missingAssets++;
                    continue;
                }
                let valid = this.isCurrent(cached, asset);
                if (valid) {
                    // A read or digest failure is not itself proof of corruption.
                    // Propagate it so the user can retry without losing good data.
                    const bytes = await cached.arrayBuffer();
                    if (signal?.aborted) throw new DOMException('Verification cancelled', 'AbortError');
                    if (bytes.byteLength !== asset.bytes) {
                        valid = false;
                    } else {
                        const rawDigest = await this.subtleCrypto.digest('SHA-256', bytes);
                        if (signal?.aborted) throw new DOMException('Verification cancelled', 'AbortError');
                        const actualIntegrity = 'sha256-' +
                            btoa(String.fromCharCode(...new Uint8Array(rawDigest)));
                        valid = actualIntegrity === asset.integrity;
                    }
                }
                if (valid) {
                    verifiedBytes += asset.bytes;
                } else {
                    if (!await cache.delete(key)) {
                        throw new Error('Unable to remove corrupted cached model data');
                    }
                    removedAssets++;
                }
                onProgress?.({ verifiedBytes, totalBytes, removedAssets, missingAssets });
            }
            return {
                ready: verifiedBytes === totalBytes,
                verifiedBytes, totalBytes, removedAssets, missingAssets,
            };
        }, { signal, lockManager: this.lockManager });
    }

    async remove(manifest) {
        return withModelDataLock(async () => {
            validateModelManifest(manifest);
            const cache = await this.cacheStorage.open(CACHE_NAME);
            for (const asset of manifest.assets) {
                await cache.delete(this.key(manifest, asset));
            }
        }, { lockManager: this.lockManager });
    }

    // Explicit cleanup after a model revision/catalog update. The caller supplies
    // ALL currently retained manifests so installed alternatives are not lost.
    async removeUnreferenced(retainedManifests) {
        return withModelDataLock(async () => {
            if (!Array.isArray(retainedManifests)) {
                throw new TypeError('Retained model manifests must be an array');
            }
            const retained = new Set();
            for (const manifest of retainedManifests) {
                validateModelManifest(manifest);
                for (const asset of manifest.assets) {
                    retained.add(this.key(manifest, asset));
                }
            }
            const prefix = new URL('model-data/', CACHE_KEY_ORIGIN).href;
            const cache = await this.cacheStorage.open(CACHE_NAME);
            let deleted = 0;
            for (const request of await cache.keys()) {
                if (request.url.startsWith(prefix) && !retained.has(request.url)) {
                    if (await cache.delete(request)) deleted++;
                }
            }
            return deleted;
        }, { lockManager: this.lockManager });
    }
}
