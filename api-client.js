/**
 * Shared Kokoro-FastAPI client helpers for the settings popup.
 * Classic script + CJS export for Jest.
 *
 * Voice IDs are normalized once at the API boundary into string IDs
 * (e.g. "af_alloy") so the rest of the UI never checks response shapes.
 */

const VOICE_PREFIXES = ['am_', 'af_', 'bm_', 'bf_'];
/** Match background.js health-check timeout. */
const DEFAULT_FETCH_TIMEOUT_MS = 3000;

function makeAbortError(message) {
    const err = new Error(message || 'The operation was aborted');
    err.name = 'AbortError';
    return err;
}

function makeTimeoutError(message) {
    const err = new Error(message || 'The operation timed out');
    err.name = 'TimeoutError';
    return err;
}

/**
 * fetch() with AbortController timeout (and optional external abort signal).
 * - Timeout → TimeoutError (classified as network; callers may fall back)
 * - External abort → AbortError (superseded; callers should stop)
 * Uses Promise.race so "Checking…" cannot hang even if fetchImpl ignores signal.
 * Optional responseConsumer keeps the same timeout/abort race active through
 * response validation and body parsing (hung response.json() cannot stick Checking).
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [timeoutMs]
 * @param {(response: Response) => Promise<*>} [responseConsumer]
 */
async function fetchWithTimeout(url, options, fetchImpl, timeoutMs, responseConsumer) {
    const fetchFn = fetchImpl || fetch;
    const ms = typeof timeoutMs === 'number' && timeoutMs >= 0
        ? timeoutMs
        : DEFAULT_FETCH_TIMEOUT_MS;
    const opts = options || {};
    const external = opts.signal;

    const controller = new AbortController();
    let timeoutId = null;
    let onExternalAbort = null;
    let timedOut = false;
    let externallyAborted = !!(external && external.aborted);

    const abortLocal = () => {
        try {
            controller.abort();
        } catch (_) {
            /* ignore */
        }
    };

    if (external) {
        if (external.aborted) {
            externallyAborted = true;
            abortLocal();
        } else {
            onExternalAbort = () => {
                externallyAborted = true;
                abortLocal();
            };
            external.addEventListener('abort', onExternalAbort);
        }
    }

    if (!controller.signal.aborted && ms > 0) {
        timeoutId = setTimeout(() => {
            timedOut = true;
            abortLocal();
        }, ms);
    } else if (ms === 0 && !controller.signal.aborted) {
        timedOut = true;
        abortLocal();
    }

    const abortPromise = new Promise((_, reject) => {
        const rejectAbort = () => {
            if (externallyAborted) {
                reject(makeAbortError('The operation was aborted'));
            } else {
                reject(makeTimeoutError('The operation timed out'));
            }
        };
        if (controller.signal.aborted) {
            rejectAbort();
            return;
        }
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });

    try {
        const fetchPromise = fetchFn(url, {
            ...opts,
            signal: controller.signal,
        });
        const response = await Promise.race([fetchPromise, abortPromise]);
        if (typeof responseConsumer === 'function') {
            // Keep timeout armed until validation + JSON parse finish.
            return await Promise.race([
                responseConsumer(response),
                abortPromise,
            ]);
        }
        return response;
    } finally {
        if (timeoutId != null) {
            clearTimeout(timeoutId);
        }
        if (external && onExternalAbort) {
            external.removeEventListener('abort', onExternalAbort);
        }
    }
}

/**
 * Normalize one voice list entry to a string ID, or null if unusable.
 * Supports legacy strings and { id } objects (fallback: name).
 */
function normalizeVoiceEntry(entry) {
    if (typeof entry === 'string') {
        const id = entry.trim();
        return id || null;
    }
    if (entry && typeof entry === 'object') {
        const raw = entry.id != null ? entry.id : entry.name;
        if (typeof raw === 'string') {
            const id = raw.trim();
            return id || null;
        }
    }
    return null;
}

/**
 * Normalize a voices array (or missing/non-array) into string IDs.
 * Invalid entries are skipped; never throws.
 */
function normalizeVoiceIds(voices) {
    if (!Array.isArray(voices)) {
        return [];
    }
    const ids = [];
    for (let i = 0; i < voices.length; i++) {
        const id = normalizeVoiceEntry(voices[i]);
        if (id) {
            ids.push(id);
        }
    }
    return ids;
}

/**
 * Keep voices matching the supported language/gender prefixes.
 */
function filterVoicesByPrefix(voiceIds, prefixes) {
    const list = Array.isArray(voiceIds) ? voiceIds : [];
    const prefs = Array.isArray(prefixes) && prefixes.length ? prefixes : VOICE_PREFIXES;
    return list.filter((v) => typeof v === 'string' && prefs.some((prefix) => v.startsWith(prefix)));
}

/**
 * Parse /audio/voices JSON into filtered string IDs + shape diagnostics.
 * @returns {{ voices: string[], shapeOk: boolean }}
 */
function parseVoicesResponse(data) {
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
        return { voices: [], shapeOk: false };
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'voices')) {
        return { voices: [], shapeOk: false };
    }
    if (!Array.isArray(data.voices)) {
        return { voices: [], shapeOk: false };
    }
    const normalized = normalizeVoiceIds(data.voices);
    return {
        voices: filterVoicesByPrefix(normalized),
        shapeOk: true,
    };
}

/**
 * Classify a thrown value from fetch / Response handling.
 * @returns {'network'|'http'|'malformed'}
 */
function classifyApiFailure(error) {
    if (!error) {
        return 'network';
    }
    if (error.kind === 'http' || error.kind === 'malformed' || error.kind === 'network') {
        return error.kind;
    }
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        return 'network';
    }
    // JSON parse / intentional shape errors
    if (error.name === 'SyntaxError' || error.kind === 'malformed') {
        return 'malformed';
    }
    // fetch() network failures are typically TypeError
    if (error instanceof TypeError || error.name === 'TypeError') {
        return 'network';
    }
    return 'network';
}

function messageForKind(kind, context) {
    const ctx = context || 'API';
    switch (kind) {
        case 'ok':
            return 'Connected successfully!';
        case 'checking':
            return 'Checking connection\u2026';
        case 'http':
            return `${ctx} returned an HTTP error. Check the URL and server logs.`;
        case 'malformed':
            return `${ctx} responded, but the response format is unsupported.`;
        case 'empty':
            return 'Connected, but no matching voices were returned.';
        case 'permission':
            return 'Host permission was denied for this URL.';
        case 'network':
        default:
            return `Unable to reach ${ctx}. Check the URL and ensure the server is running.`;
    }
}

/**
 * Combine probe + voices results. Successful voices prove connectivity even
 * when `/test` fails; probe errors only win when the functional request fails too.
 */
function resolveBackendStatus(probe, voicesResult) {
    const voices = (voicesResult && voicesResult.voices) || [];
    if (voicesResult && voicesResult.ok) {
        if (voicesResult.kind === 'empty') {
            return {
                kind: 'empty',
                message: voicesResult.message || messageForKind('empty'),
                voices,
                showRetry: true,
            };
        }
        return {
            kind: 'ok',
            message: messageForKind('ok'),
            voices,
            showRetry: false,
        };
    }
    if (probe && probe.ok) {
        return {
            kind: voicesResult.kind,
            message: voicesResult.message || messageForKind(voicesResult.kind, 'Voice list'),
            voices: [],
            showRetry: true,
        };
    }
    // Both failed — prefer probe classification for the shared host.
    const kind = (probe && probe.kind) || (voicesResult && voicesResult.kind) || 'network';
    return {
        kind,
        message: (probe && probe.message)
            || (voicesResult && voicesResult.message)
            || messageForKind(kind, 'API'),
        voices: [],
        showRetry: true,
    };
}

async function tryProbeTest(baseUrl, fetchImpl, requestOpts, timeoutMs) {
    return fetchWithTimeout(
        `${baseUrl}test`,
        {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: requestOpts.signal,
        },
        fetchImpl,
        timeoutMs,
        async (response) => {
            if (!response.ok) {
                const err = new Error(`HTTP ${response.status}`);
                err.kind = 'http';
                err.status = response.status;
                throw err;
            }
            let data;
            try {
                data = await response.json();
            } catch (parseErr) {
                const err = new Error('Invalid JSON from /test');
                err.kind = 'malformed';
                err.cause = parseErr;
                throw err;
            }
            if (!data || data.status !== 'ok') {
                const err = new Error('Unexpected /test payload');
                err.kind = 'malformed';
                throw err;
            }
            return { ok: true, kind: 'ok', message: messageForKind('ok') };
        }
    );
}

async function tryProbeHealth(apiUrl, fetchImpl, requestOpts, timeoutMs) {
    const urlObj = new URL(apiUrl);
    const healthUrl = new URL('/health', urlObj.origin).href;
    return fetchWithTimeout(
        healthUrl,
        {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: requestOpts.signal,
        },
        fetchImpl,
        timeoutMs,
        async (response) => {
            if (!response.ok) {
                const err = new Error(`HTTP ${response.status}`);
                err.kind = 'http';
                err.status = response.status;
                throw err;
            }
            let data;
            try {
                data = await response.json();
            } catch (parseErr) {
                const err = new Error('Invalid JSON from /health');
                err.kind = 'malformed';
                err.cause = parseErr;
                throw err;
            }
            if (!data || data.status !== 'healthy') {
                const err = new Error('Unexpected /health payload');
                err.kind = 'malformed';
                throw err;
            }
            return { ok: true, kind: 'ok', message: messageForKind('ok') };
        }
    );
}

/**
 * Probe connectivity: GET {apiUrl}test, then /health fallback (same as background.js).
 * Options: { signal, timeoutMs }
 */
async function probeApiConnection(apiUrl, fetchImpl, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs;
    const requestOpts = { signal: opts.signal };
    const baseUrl = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
    let lastFailure = null;

    try {
        return await tryProbeTest(baseUrl, fetchImpl, requestOpts, timeoutMs);
    } catch (e) {
        // External supersede — stop without /health. Timeout falls through to /health.
        if (e && e.name === 'AbortError') {
            return {
                ok: false,
                kind: 'network',
                aborted: true,
                message: messageForKind('network', 'API'),
            };
        }
        lastFailure = e;
    }

    try {
        return await tryProbeHealth(apiUrl, fetchImpl, requestOpts, timeoutMs);
    } catch (e) {
        if (e && e.name === 'AbortError') {
            return {
                ok: false,
                kind: 'network',
                aborted: true,
                message: messageForKind('network', 'API'),
            };
        }
        lastFailure = e;
    }

    const kind = classifyApiFailure(lastFailure);
    return { ok: false, kind, message: messageForKind(kind, 'API') };
}

/**
 * Fetch and normalize voice IDs from GET {apiUrl}audio/voices.
 * Options: { signal, timeoutMs }
 */
async function fetchNormalizedVoices(apiUrl, fetchImpl, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs;
    try {
        return await fetchWithTimeout(
            `${apiUrl}audio/voices`,
            { signal: opts.signal },
            fetchImpl,
            timeoutMs,
            async (response) => {
                if (!response.ok) {
                    const err = new Error(`HTTP ${response.status}`);
                    err.kind = 'http';
                    err.status = response.status;
                    throw err;
                }
                let data;
                try {
                    data = await response.json();
                } catch (parseErr) {
                    const err = new Error('Invalid JSON from /audio/voices');
                    err.kind = 'malformed';
                    err.cause = parseErr;
                    throw err;
                }
                const parsed = parseVoicesResponse(data);
                if (!parsed.shapeOk) {
                    return {
                        ok: false,
                        kind: 'malformed',
                        voices: [],
                        message: messageForKind('malformed', 'Voice list'),
                    };
                }
                if (parsed.voices.length === 0) {
                    return {
                        ok: true,
                        kind: 'empty',
                        voices: [],
                        message: messageForKind('empty'),
                    };
                }
                return {
                    ok: true,
                    kind: 'ok',
                    voices: parsed.voices,
                    message: '',
                };
            }
        );
    } catch (e) {
        const kind = classifyApiFailure(e);
        return {
            ok: false,
            kind,
            voices: [],
            message: messageForKind(kind, 'Voice list'),
        };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VOICE_PREFIXES,
        DEFAULT_FETCH_TIMEOUT_MS,
        fetchWithTimeout,
        normalizeVoiceEntry,
        normalizeVoiceIds,
        filterVoicesByPrefix,
        parseVoicesResponse,
        classifyApiFailure,
        messageForKind,
        resolveBackendStatus,
        probeApiConnection,
        fetchNormalizedVoices,
    };
}
