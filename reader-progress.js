/**
 * Durable reader resume helpers (#196).
 * Progress lives in browser.storage.local under STORAGE_KEY — never sync,
 * and never stores full document source or pendingText as a bookmark key.
 */

/** Legacy single-map key (migrated on read; new writes use per-document keys). */
export const STORAGE_KEY = 'readerProgressByDocumentId';
/** Per-document keys avoid multi-tab read-modify-write clobbering other files. */
export const STORAGE_KEY_PREFIX = 'readerProgress:';
export const MAX_STORED_DOCUMENTS = 24;

export function progressStorageKey(documentId) {
    return STORAGE_KEY_PREFIX + String(documentId || '');
}

const DIGEST_RE = /^[a-f0-9]{64}$/;

export function documentIdFromDigest(hexDigest) {
    const hex = String(hexDigest || '').toLowerCase();
    if (!DIGEST_RE.test(hex)) {
        throw new TypeError('Invalid SHA-256 hex digest for reader document id');
    }
    return 'sha256:' + hex;
}

function bytesOf(buffer) {
    if (Object.prototype.toString.call(buffer) === '[object ArrayBuffer]') {
        return new Uint8Array(buffer);
    }
    if (ArrayBuffer.isView(buffer)) {
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    throw new TypeError('Document digest requires an ArrayBuffer');
}

export async function hexDigestFromBuffer(buffer) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== 'function') {
        throw new Error('SubtleCrypto digest is unavailable for reader progress hashing');
    }
    const digest = await subtle.digest('SHA-256', bytesOf(buffer));
    return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/** Fast non-crypto fingerprint of chapter block text for restore validation. */
export function fingerprintChapterBlocks(blocks) {
    const parts = Array.isArray(blocks)
        ? blocks.map((b) => String(b?.content || ''))
        : [];
    const joined = parts.join('\u0001');
    // FNV-1a 64-bit as hex (two 32-bit halves) — stable across sessions.
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5 ^ 0x9e3779b9;
    for (let i = 0; i < joined.length; i++) {
        const c = joined.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 ^= c ^ 0x9e3779b9;
        h2 = Math.imul(h2, 0x01000193) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function buildProgressRecord({
    documentId,
    name,
    size,
    format,
    chapterHref,
    blockIndex,
    chapterFingerprint,
    revision,
    updatedAt,
}) {
    const id = String(documentId || '');
    if (!id.startsWith('sha256:') || !DIGEST_RE.test(id.slice(7))) {
        throw new TypeError('Progress record requires a sha256 document id');
    }
    const index = Number(blockIndex);
    if (!Number.isInteger(index) || index < 0) {
        throw new TypeError('Progress record requires a non-negative blockIndex');
    }
    const rev = Number(revision);
    if (!Number.isInteger(rev) || rev < 1) {
        throw new TypeError('Progress record requires a positive revision');
    }
    return {
        documentId: id,
        name: String(name || '').slice(0, 260),
        size: Number.isFinite(size) ? Number(size) : 0,
        format: String(format || ''),
        chapterHref: chapterHref == null ? null : String(chapterHref),
        blockIndex: index,
        chapterFingerprint: String(chapterFingerprint || ''),
        revision: rev,
        updatedAt: Number(updatedAt) || Date.now(),
    };
}

export function shouldAcceptProgressWrite({
    writeRevision,
    currentRevision,
    writeChapterRequestId,
    currentChapterRequestId,
    writeDocumentId,
    currentDocumentId,
}) {
    return writeRevision === currentRevision &&
        writeChapterRequestId === currentChapterRequestId &&
        writeDocumentId === currentDocumentId &&
        Boolean(writeDocumentId);
}

/** Overlay init must not clobber a saved position while Resume/Start over is open. */
export function shouldPersistProgressUpdate({ resumeDecisionPending }) {
    return !resumeDecisionPending;
}

export function resolveResumeTarget({
    record,
    flatToc,
    chapterFingerprint,
    chapterBlockCount,
}) {
    if (!record || typeof record !== 'object') {
        return { ok: false, reason: 'missing-record' };
    }
    const href = record.chapterHref;
    const toc = Array.isArray(flatToc) ? flatToc : [];
    const match = href == null
        ? (toc.length === 1 ? toc[0] : null)
        : toc.find((item) => item?.href === href);
    if (!match) {
        return { ok: false, reason: 'chapter-missing' };
    }
    if (String(record.chapterFingerprint || '') !== String(chapterFingerprint || '')) {
        return { ok: false, reason: 'fingerprint-mismatch' };
    }
    const index = Number(record.blockIndex);
    const count = Number(chapterBlockCount);
    if (!Number.isInteger(index) || index < 0 ||
        !Number.isInteger(count) || index >= count) {
        return { ok: false, reason: 'block-out-of-range' };
    }
    return {
        ok: true,
        chapterHref: match.href ?? href,
        blockIndex: index,
        label: match.label || 'Chapter',
    };
}

function isProgressRecord(value) {
    return value && typeof value === 'object' && typeof value.documentId === 'string';
}

/** Collect records from per-document keys plus the legacy map. */
export function collectProgressRecords(store) {
    const out = {};
    if (!store || typeof store !== 'object') return out;
    const legacy = store[STORAGE_KEY];
    if (legacy && typeof legacy === 'object') {
        for (const [id, record] of Object.entries(legacy)) {
            if (isProgressRecord(record)) out[id] = record;
        }
    }
    for (const [key, value] of Object.entries(store)) {
        if (!key.startsWith(STORAGE_KEY_PREFIX) || !isProgressRecord(value)) continue;
        out[value.documentId] = value;
    }
    return out;
}

/**
 * Write one document key and prune older entries without rewriting unrelated
 * documents' values (multi-tab safe for distinct files).
 * Returns { set, remove } payloads for browser.storage.local.
 */
export function planProgressUpsert(store, record) {
    const map = collectProgressRecords(store);
    map[record.documentId] = record;
    const ranked = Object.values(map)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const keep = ranked.slice(0, MAX_STORED_DOCUMENTS);
    const keepIds = new Set(keep.map((entry) => entry.documentId));
    const set = { [progressStorageKey(record.documentId)]: record };
    const remove = [];
    if (store[STORAGE_KEY]) remove.push(STORAGE_KEY);
    for (const id of Object.keys(map)) {
        if (keepIds.has(id)) continue;
        remove.push(progressStorageKey(id));
    }
    for (const [key, value] of Object.entries(store || {})) {
        if (!key.startsWith(STORAGE_KEY_PREFIX) || !isProgressRecord(value)) continue;
        if (!keepIds.has(value.documentId)) remove.push(key);
    }
    return { set, remove: [...new Set(remove)] };
}

/** Test helper: apply an upsert into an in-memory store snapshot. */
export function upsertProgress(store, record) {
    const plan = planProgressUpsert(store, record);
    const next = { ...(store || {}) };
    for (const key of plan.remove) delete next[key];
    Object.assign(next, plan.set);
    const kept = collectProgressRecords(next);
    kept[record.documentId] = record;
    const ranked = Object.values(kept)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, MAX_STORED_DOCUMENTS);
    const map = Object.fromEntries(ranked.map((entry) => [entry.documentId, entry]));
    const out = { [STORAGE_KEY]: map };
    for (const entry of ranked) {
        out[progressStorageKey(entry.documentId)] = entry;
    }
    return out;
}

export function planProgressRemove(store, documentId) {
    const remove = [progressStorageKey(documentId)];
    if (store?.[STORAGE_KEY]) remove.push(STORAGE_KEY);
    return { remove: [...new Set(remove)] };
}

export function removeProgress(store, documentId) {
    const map = collectProgressRecords(store);
    delete map[documentId];
    return { [STORAGE_KEY]: map };
}

export function clearAllProgress(store) {
    void store;
    return { [STORAGE_KEY]: {} };
}

export function readProgressRecord(store, documentId) {
    if (!store || typeof store !== 'object') return null;
    const keyed = store[progressStorageKey(documentId)];
    if (isProgressRecord(keyed)) return keyed;
    const map = collectProgressRecords(store);
    return map[documentId] || null;
}

export function shouldOfferResumeChoice(target, firstChapterHref) {
    if (!target?.ok || !Number.isInteger(target.blockIndex)) return false;
    if (target.blockIndex > 0) return true;
    return Boolean(target.chapterHref) && target.chapterHref !== firstChapterHref;
}
