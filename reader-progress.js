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
 * Write the current document's key and prune older entries.
 * Never materialize peer per-document keys from a legacy snapshot — concurrent
 * tabs reading the same legacy-only map would otherwise clobber each other.
 * Legacy peers stay in a pruned `STORAGE_KEY` map until each tab writes its
 * own key (or the map becomes empty and is removed).
 * Returns { set, remove } payloads for browser.storage.local.
 */
export function planProgressUpsert(store, record) {
    const map = collectProgressRecords(store);
    map[record.documentId] = record;
    const ranked = Object.values(map)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const keep = ranked.slice(0, MAX_STORED_DOCUMENTS);
    const keepIds = new Set(keep.map((entry) => entry.documentId));
    const set = {
        [progressStorageKey(record.documentId)]: record,
    };
    const remove = [];
    const legacy = store?.[STORAGE_KEY];
    if (legacy && typeof legacy === 'object') {
        // Keep unmigrated peers in the legacy map only — never write peer keys.
        const nextLegacy = {};
        for (const entry of keep) {
            if (entry.documentId === record.documentId) continue;
            const key = progressStorageKey(entry.documentId);
            if (isProgressRecord(store[key])) continue;
            const fromLegacy = legacy[entry.documentId];
            nextLegacy[entry.documentId] = isProgressRecord(fromLegacy)
                ? fromLegacy
                : entry;
        }
        if (Object.keys(nextLegacy).length === 0) {
            remove.push(STORAGE_KEY);
        } else {
            set[STORAGE_KEY] = nextLegacy;
        }
    }
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

/**
 * True when the resume lookup still belongs to the committed document open.
 * Uses monotonic `openGeneration` (not progressRevision) so a hash-failure
 * clear followed by a later successful commit cannot reuse an earlier token.
 */
export function isResumeLookupStillCurrent({
    capturedDocumentId,
    capturedOpenGeneration,
    currentMeta,
}) {
    return Boolean(capturedDocumentId) &&
        Number.isInteger(capturedOpenGeneration) &&
        currentMeta?.documentId === capturedDocumentId &&
        currentMeta?.openGeneration === capturedOpenGeneration;
}

/**
 * After applying `plan.set`, re-rank against a fresh store snapshot and keep
 * only removals both the original plan and the fresh plan agree on. Prevents
 * a concurrent peer upsert from being deleted by a stale eviction list.
 * Pair with `runExclusiveProgressMutation` — reconcile alone cannot see peer
 * updates that land after the fresh snapshot is taken.
 */
export function reconcileProgressRemoves(plannedRemove, store, record) {
    const planned = Array.isArray(plannedRemove) ? plannedRemove : [];
    if (!planned.length) return [];
    const fresh = planProgressUpsert(store, record);
    const freshRemove = new Set(fresh.remove);
    return planned.filter((key) => freshRemove.has(key));
}

/** Cross-tab exclusive lock name for progress get→plan→set→remove. */
export const PROGRESS_STORAGE_LOCK = 'kokoro-reader-progress';

/**
 * Serialize progress storage mutations across reader tabs via Web Locks.
 * Supported reader contexts already expose LockManager: Firefox requires
 * gecko `strict_min_version` 142+ (Web Locks since 96), and Chrome MV3
 * extension pages include `navigator.locks`. The no-lock fallback exists
 * only for jsdom / hosts without LockManager — production reader tabs
 * should not hit it.
 */
export async function runExclusiveProgressMutation(task, {
    locks = globalThis.navigator?.locks,
    lockName = PROGRESS_STORAGE_LOCK,
} = {}) {
    if (!locks || typeof locks.request !== 'function') {
        return task();
    }
    return locks.request(lockName, { mode: 'exclusive' }, () => task());
}

/**
 * get→plan→set→reconcile→remove under the exclusive progress lock.
 * Injectable storage hooks keep the path unit-testable without reader DOM.
 */
export async function applyProgressUpsertMutation({
    record,
    getStore,
    setStore,
    removeKeys,
    locks = globalThis.navigator?.locks,
    isCurrent = () => true,
}) {
    return runExclusiveProgressMutation(async () => {
        if (!isCurrent()) return;
        const stored = await getStore();
        if (!isCurrent()) return;
        const plan = planProgressUpsert(stored || {}, record);
        if (plan.set && Object.keys(plan.set).length) {
            if (!isCurrent()) return;
            await setStore(plan.set);
        }
        if (!plan.remove.length) return;
        if (!isCurrent()) return;
        const afterSet = await getStore();
        if (!isCurrent()) return;
        const safeRemove = reconcileProgressRemoves(
            plan.remove, afterSet || {}, record,
        );
        if (safeRemove.length) await removeKeys(safeRemove);
    }, { locks });
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
    const map = collectProgressRecords(store);
    delete map[documentId];
    const set = {};
    const remove = [progressStorageKey(documentId)];
    const legacy = store?.[STORAGE_KEY];
    if (legacy && typeof legacy === 'object') {
        // Keep remaining unmigrated peers in the legacy map — do not write
        // their per-document keys from this snapshot (same concurrent-migration
        // rule as planProgressUpsert).
        const nextLegacy = {};
        for (const entry of Object.values(map)) {
            const key = progressStorageKey(entry.documentId);
            if (isProgressRecord(store[key])) continue;
            const fromLegacy = legacy[entry.documentId];
            nextLegacy[entry.documentId] = isProgressRecord(fromLegacy)
                ? fromLegacy
                : entry;
        }
        if (Object.keys(nextLegacy).length === 0) {
            remove.push(STORAGE_KEY);
        } else {
            set[STORAGE_KEY] = nextLegacy;
        }
    }
    return { set, remove: [...new Set(remove)] };
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

// --- Bookmarks (same document identity / local-only storage as progress) ---

export const BOOKMARK_STORAGE_KEY_PREFIX = 'readerBookmarks:';
export const MAX_BOOKMARKS_PER_DOCUMENT = 40;

export function bookmarkStorageKey(documentId) {
    return BOOKMARK_STORAGE_KEY_PREFIX + String(documentId || '');
}

function isBookmarkRecord(value) {
    return value && typeof value === 'object' &&
        typeof value.id === 'string' &&
        typeof value.documentId === 'string' &&
        Number.isInteger(value.blockIndex) && value.blockIndex >= 0;
}

export function buildBookmarkRecord({
    id,
    documentId,
    label,
    chapterHref,
    blockIndex,
    chapterFingerprint,
    createdAt,
}) {
    const docId = String(documentId || '');
    if (!docId.startsWith('sha256:') || !DIGEST_RE.test(docId.slice(7))) {
        throw new TypeError('Bookmark requires a sha256 document id');
    }
    const index = Number(blockIndex);
    if (!Number.isInteger(index) || index < 0) {
        throw new TypeError('Bookmark requires a non-negative blockIndex');
    }
    const bookmarkId = String(id || '').trim();
    if (!bookmarkId) {
        throw new TypeError('Bookmark requires an id');
    }
    return {
        id: bookmarkId.slice(0, 80),
        documentId: docId,
        label: String(label || 'Bookmark').slice(0, 120),
        chapterHref: chapterHref == null ? null : String(chapterHref),
        blockIndex: index,
        chapterFingerprint: String(chapterFingerprint || ''),
        createdAt: Number(createdAt) || Date.now(),
    };
}

export function readBookmarks(store, documentId) {
    if (!store || typeof store !== 'object' || !documentId) return [];
    const raw = store[bookmarkStorageKey(documentId)];
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(isBookmarkRecord)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, MAX_BOOKMARKS_PER_DOCUMENT);
}

/** Add or replace a same-position bookmark; newest first; bounded. */
export function planBookmarkAdd(store, bookmark) {
    const key = bookmarkStorageKey(bookmark.documentId);
    const list = readBookmarks(store, bookmark.documentId)
        .filter((entry) => !(
            entry.chapterHref === bookmark.chapterHref &&
            entry.blockIndex === bookmark.blockIndex
        ));
    const next = [bookmark, ...list].slice(0, MAX_BOOKMARKS_PER_DOCUMENT);
    return { set: { [key]: next }, remove: [] };
}

export function planBookmarkRemove(store, documentId, bookmarkId) {
    const key = bookmarkStorageKey(documentId);
    const next = readBookmarks(store, documentId)
        .filter((entry) => entry.id !== bookmarkId);
    if (next.length === 0) return { set: {}, remove: [key] };
    return { set: { [key]: next }, remove: [] };
}

export function planBookmarkClear(store, documentId) {
    void store;
    return { set: {}, remove: [bookmarkStorageKey(documentId)] };
}

/** Validate a bookmark against the current chapter the same way as resume. */
export function resolveBookmarkTarget(args) {
    return resolveResumeTarget({
        record: args?.bookmark,
        flatToc: args?.flatToc,
        chapterFingerprint: args?.chapterFingerprint,
        chapterBlockCount: args?.chapterBlockCount,
    });
}

/**
 * Resolve which TOC entry a bookmark should open. Exact href first; if the
 * chapter list mode changed (heading scan vs publisher TOC), fall back to the
 * same spine path without the fragment.
 */
export function findBookmarkTocItem(flatToc, chapterHref) {
    const toc = Array.isArray(flatToc) ? flatToc : [];
    if (!toc.length) return null;
    if (chapterHref == null) return toc[0];
    const exact = toc.find((entry) => entry?.href === chapterHref);
    if (exact) return exact;
    const base = String(chapterHref).split('#')[0];
    const byBase = toc.filter((entry) => String(entry?.href || '').split('#')[0] === base);
    if (!byBase.length) return null;
    return byBase.find((entry) => !String(entry.href || '').includes('#')) || byBase[0];
}

/**
 * Pair a bookmark with the active TOC entry, rewriting chapterHref when the
 * spine-path fallback selected a different TOC href so fingerprint/block
 * validation does not fail with chapter-missing.
 */
export function prepareBookmarkForCurrentToc(bookmark, flatToc) {
    if (!bookmark) return { item: null, record: null };
    const item = findBookmarkTocItem(flatToc, bookmark.chapterHref);
    if (!item) return { item: null, record: null };
    if (bookmark.chapterHref === item.href) {
        return { item, record: bookmark };
    }
    return { item, record: { ...bookmark, chapterHref: item.href } };
}

/** Playback seek for a validated bookmark — never autoplays. */
export function resolveBookmarkPlayback({
    bookmark,
    flatToc,
    chapterFingerprint,
    chapterBlockCount,
}) {
    const target = resolveBookmarkTarget({
        bookmark,
        flatToc,
        chapterFingerprint,
        chapterBlockCount,
    });
    if (target.ok) {
        return {
            startIndex: target.blockIndex,
            suppressAutoplay: true,
            outdated: false,
            label: target.label,
        };
    }
    return { startIndex: 0, suppressAutoplay: true, outdated: true, label: null };
}
