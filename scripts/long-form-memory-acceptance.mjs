/**
 * Chromium long-form memory/performance live-acceptance helpers.
 * Speech tokens are CMUdict-friendly English number words for ONNX q8.
 */

export const LONG_FORM_SENTENCE_COUNT = 24;

/** Steady-state retainWindow(center, 2, 2) holds at most five indices; allow
 *  brief transition slack while the active source is replaced and prefetched. */
export const LONG_FORM_MAX_CACHE_ENTRIES = 8;
export const LONG_FORM_MAX_OBJECT_URLS = 8;

export const LONG_FORM_NUMBER_WORDS = Object.freeze([
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
    'fifty', 'sixty',
]);

export const ALLOWED_LONG_FORM_BACKENDS = Object.freeze(['onnx']);

export function requireLongFormBackend(backend) {
    if (!ALLOWED_LONG_FORM_BACKENDS.includes(backend)) {
        throw new Error(
            'Long-form memory acceptance requires onnx backend, got: ' +
            String(backend));
    }
    return backend;
}

export function originLongFormMemoryStageEnabled(originDownload, provider, success) {
    return Boolean(
        originDownload &&
        ALLOWED_LONG_FORM_BACKENDS.includes(provider) &&
        success);
}

export function buildLongFormSpeechLines() {
    if (LONG_FORM_NUMBER_WORDS.length < LONG_FORM_SENTENCE_COUNT) {
        throw new Error('LONG_FORM_NUMBER_WORDS shorter than LONG_FORM_SENTENCE_COUNT');
    }
    return LONG_FORM_NUMBER_WORDS.slice(0, LONG_FORM_SENTENCE_COUNT)
        .map(word => 'Hello ' + word + '.');
}

export function buildLongFormPendingContent() {
    return buildLongFormSpeechLines().map(content => ({ type: 'text', content }));
}

export function longFormStorageConfig(backend) {
    requireLongFormBackend(backend);
    const lines = buildLongFormSpeechLines();
    return {
        pendingTtsBackend: backend,
        pendingApiUrl: null,
        pendingText: lines.join(' '),
        pendingContent: buildLongFormPendingContent(),
        pendingTitle: 'Kokoro long-form memory acceptance',
        pendingAutoplay: false,
        pendingAcceptanceProbe: true,
        ttsBackend: backend,
        apiUrl: '',
        mode: 'stream',
        mediaPipeVariant: 'cpu',
        localVoice: 'af_heart',
    };
}

export function assertBoundedAudioManagerStats(stats, options = {}) {
    const maxCache = options.maxCacheEntries ?? LONG_FORM_MAX_CACHE_ENTRIES;
    const maxUrls = options.maxObjectUrls ?? LONG_FORM_MAX_OBJECT_URLS;
    const minSentences = options.minSentences ?? LONG_FORM_SENTENCE_COUNT;
    if (!stats || typeof stats !== 'object') {
        throw new Error('AudioManager acceptance probe missing: ' + String(stats));
    }
    if (!Number.isInteger(stats.sentenceCount) || stats.sentenceCount < minSentences) {
        throw new Error('Long-form sentence count too small: ' + JSON.stringify(stats));
    }
    if (!Number.isInteger(stats.cacheSize) || stats.cacheSize > maxCache) {
        throw new Error('AudioManager cache exceeded bound: ' + JSON.stringify({
            cacheSize: stats.cacheSize, maxCache, stats,
        }));
    }
    if (!Number.isInteger(stats.objectUrlCount) || stats.objectUrlCount > maxUrls) {
        throw new Error('AudioManager object URLs exceeded bound: ' + JSON.stringify({
            objectUrlCount: stats.objectUrlCount, maxUrls, stats,
        }));
    }
    return true;
}

export function assertLongFormHeapDelta(beforeBytes, afterBytes, options = {}) {
    const maxGrowthBytes = options.maxGrowthBytes ?? 256 * 1024 * 1024;
    if (!Number.isFinite(beforeBytes) || !Number.isFinite(afterBytes)) {
        throw new Error('Heap samples missing: ' + JSON.stringify({ beforeBytes, afterBytes }));
    }
    const growth = afterBytes - beforeBytes;
    if (growth > maxGrowthBytes) {
        throw new Error('Long-form JS heap growth exceeded bound: ' + JSON.stringify({
            beforeBytes, afterBytes, growth, maxGrowthBytes,
        }));
    }
    return { growth, maxGrowthBytes };
}
