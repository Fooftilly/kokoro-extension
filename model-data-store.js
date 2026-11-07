// Original, extension-origin model data cache. No automatic model downloads.
// Executable SDK JS/WASM must be shipped with the extension, never fetched here.
// Cache API request keys must have HTTP(S) schemes even in extension-owned caches.
// This reserved .invalid URL is never fetched; Cache Storage is scoped to the extension origin.
const CACHE_KEY_ORIGIN = 'https://kokoro-model-cache.invalid/';
const CACHE_NAME = 'kokoro-model-data-v1';
const ALLOWED_PROVIDERS = Object.freeze(['mediapipe', 'onnx']);
const INTEGRITY_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const PATH_PATTERN = /^[a-zA-Z0-9._/-]+$/;

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
            asset.path.startsWith('/') || asset.path.split('/').includes('..') ||
            seen.has(asset.path) ||
            !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 ||
            !INTEGRITY_PATTERN.test(asset.integrity || '')) {
            throw new TypeError('Invalid or duplicate model asset');
        }
        const url = new URL(asset.url);
        // The supplied, pinned official Kokoro model repos both use this host.
        if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' ||
            !url.pathname.includes('/resolve/' + manifest.revision + '/')) {
            throw new TypeError('Model data must come from a pinned official Hugging Face revision');
        }
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

export class ModelDataStore {
    constructor({ origin, cacheStorage, fetchImpl, responseClass, streamClass }) {
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
            if (!response.ok || response.type === 'opaque' || !response.body) {
                throw new Error('Unable to download model data through CORS');
            }
            let received = 0;
            const bytesBefore = completedBytes;
            const stream = response.body.pipeThrough(new this.TransformStreamClass({
                transform(chunk, controller) {
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
    }

    async remove(manifest) {
        validateModelManifest(manifest);
        const cache = await this.cacheStorage.open(CACHE_NAME);
        for (const asset of manifest.assets) {
            await cache.delete(this.key(manifest, asset));
        }
    }
}
