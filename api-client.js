/**
 * Shared Kokoro-FastAPI client helpers for the settings popup.
 * Classic script + CJS export for Jest.
 *
 * Voice IDs are normalized once at the API boundary into string IDs
 * (e.g. "af_alloy") so the rest of the UI never checks response shapes.
 */

const VOICE_PREFIXES = ['am_', 'af_', 'bm_', 'bf_'];

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
    if (error.name === 'AbortError') {
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
            return 'Checking connection…';
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
 * Probe GET {apiUrl}test — distinguishes network / HTTP / malformed / success.
 * Does not poll; caller decides when to invoke.
 */
async function probeApiConnection(apiUrl, fetchImpl) {
    const fetchFn = fetchImpl || fetch;
    const baseUrl = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
    try {
        const response = await fetchFn(`${baseUrl}test`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
        });
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
    } catch (e) {
        const kind = classifyApiFailure(e);
        return { ok: false, kind, message: messageForKind(kind, 'API') };
    }
}

/**
 * Fetch and normalize voice IDs from GET {apiUrl}audio/voices.
 */
async function fetchNormalizedVoices(apiUrl, fetchImpl) {
    const fetchFn = fetchImpl || fetch;
    try {
        const response = await fetchFn(`${apiUrl}audio/voices`);
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
        normalizeVoiceEntry,
        normalizeVoiceIds,
        filterVoicesByPrefix,
        parseVoicesResponse,
        classifyApiFailure,
        messageForKind,
        probeApiConnection,
        fetchNormalizedVoices,
    };
}
