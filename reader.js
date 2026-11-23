import {
    MAX_TEXT_DOCUMENT_BYTES,
    detectDocumentFormat,
    decodeTextDocument,
    parseTextDocument,
} from './document-formats.js';
import { MAX_DOCX_ARCHIVE_BYTES, parseDocxDocument } from './docx-reader.js';
import {
    documentIdFromDigest,
    hexDigestFromBuffer,
    fingerprintChapterBlocks,
    buildProgressRecord,
    shouldAcceptProgressWrite,
    shouldPersistProgressUpdate,
    shouldOfferResumeChoice,
    resolveResumeTarget,
    planProgressRemove,
    applyProgressUpsertMutation,
    runExclusiveProgressMutation,
    isResumeLookupStillCurrent,
    readProgressRecord,
    buildBookmarkRecord,
    readBookmarks,
    planBookmarkAdd,
    planBookmarkRemove,
    planBookmarkClear,
    findBookmarkTocItem,
    resolveBookmarkPlayback,
} from './reader-progress.js';
import './tts-providers.js';
import './local-voice-mixing.js';

const fileInput = document.getElementById('fileInput');
const filePickerOverlay = document.getElementById('filePickerOverlay');
const openAnotherDocumentButton = document.getElementById('openAnotherDocument');
const cancelDocumentPickerButton = document.getElementById('cancelDocumentPicker');
const scanDocumentHeadings = document.getElementById('scanDocumentHeadings');
const chapterList = document.getElementById('chapterList');
const errorMsg = document.getElementById('errorMsg');
const chapterErrorMsg = document.getElementById('chapterError');
const loadingStatus = document.getElementById('loadingStatus');
const playerFrame = document.getElementById('playerFrame');
const sidebar = document.getElementById('sidebar');
const appContainer = document.querySelector('.app-container');
const resumeBanner = document.getElementById('resumeBanner');
const resumeBannerText = document.getElementById('resumeBannerText');
const resumeReadingButton = document.getElementById('resumeReading');
const startOverReadingButton = document.getElementById('startOverReading');
const clearReadingProgressButton = document.getElementById('clearReadingProgress');
const bookmarksPanel = document.getElementById('bookmarksPanel');
const bookmarkListEl = document.getElementById('bookmarkList');
const addBookmarkButton = document.getElementById('addBookmark');
const clearBookmarksButton = document.getElementById('clearBookmarks');

let book = null; // EPUB object
let textDocument = null; // parsed TXT/Markdown/HTML document, not an EPUB archive
let activeTextChapterWrite = Promise.resolve();
let currentChapterBlocks = []; // For tracking progress
let currentToc = []; // For resolving chapter titles
let currentActiveHref = null; // To avoid redundant updates
let flatToc = []; // Flattened list for Prev/Next navigation
let chapterRequestId = 0; // invalidates superseded chapter extraction
let playerWriteTail = Promise.resolve(); // prevents out-of-order storage writes
let fileRequestId = 0; // only the latest EPUB selection may replace the book
let activeFileReader = null; // abort abandoned disk reads when a new file is selected
const chapterTasks = new Map(); // book -> async chapter extractions still in progress
const retiringBooks = new Set(); // retain archives until new chapter data reaches player
const sectionUsers = new WeakMap(); // concurrent readers must not unload each other's DOM
let playerReloadRevision = 0; // correlate EPUB reloads with committed iframe content
let lastPublishedReload = null; // { revision, sourceBook, requestId }; only iframe acknowledgement releases archives
let renderedChapterRevision = null; // acknowledged by the embedded player
let renderedChapterHref = null; // exact TOC entry loaded for the acknowledged revision
let renderedChapterRequestId = null;
let renderedChapterContinuous = false;
let lastContinuedRevision = null; // an ended chapter may advance only once
let deferredChapterEndRevision = null; // do not advance behind the open file picker
let readerPausedForPicker = false; // Close must suppress pending chapter autoplay
/** @type {{ documentId: string, name: string, size: number, format: string, progressRevision: number, openGeneration: number } | null} */
let currentDocumentMeta = null;
let progressSaveTimer = null;
/** Validated resume target waiting on explicit Resume (never autoplays). */
let pendingResumeTarget = null;
/** Full chapter blocks for fingerprinting (independent of continuous-reader truncation). */
let currentChapterCanonicalBlocks = [];
/** Monotonic identity generation so stale hash completions cannot replace a newer commit. */
let documentIdentityGeneration = 0;
/** Monotonic open token for resume-lookup fencing across hash-failure clears. */
let documentOpenGeneration = 0;
/**
 * Last playback block for Add bookmark. Null until the current chapter
 * request reports progress (avoids image-only chapters inheriting the prior
 * chapter's index).
 */
let lastKnownBlockIndex = null;
/** Chapter request id that last reported a bookmarkable progress position. */
let bookmarkProgressChapterRequestId = null;

const prevChapterBtn = document.getElementById('prevChapter');
const nextChapterBtn = document.getElementById('nextChapter');

// The background broadcasts shortcuts to extension contexts, not to content
// scripts inside reader.html. Route them only to this reader's tab.
const readerTabId = browser.tabs.getCurrent().then(tab => tab?.id ?? null);
browser.runtime.onMessage.addListener(message => {
    if (message?.action !== 'KOKORO_READER_NAV') return;
    return readerTabId.then(tabId => {
        if (!Number.isInteger(tabId) || message.tabId !== tabId ||
            (message.direction !== 'NAV_NEXT' && message.direction !== 'NAV_PREV') ||
            !hasOpenDocument() || filePickerOverlay.style.display !== 'none') {
            return false;
        }
        playerFrame.contentWindow.postMessage(message.direction, window.location.origin);
        return true;
    });
});


// Clear stale storage before the first chapter write. An unawaited remove
// could otherwise finish after a fast first-chapter set and delete its data.
const initialPlayerCleanup = browser.storage.local.remove([
    'pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle',
]).catch(error => {
    console.warn('Cannot clear previous reader audio data', error);
});

const dropZone = document.getElementById('dropZone');
const fileNameDisplay = document.getElementById('file-name-display');

// --- Event Listeners ---

function hasOpenDocument() {
    return Boolean(book || textDocument);
}

function hideResumeBanner() {
    pendingResumeTarget = null;
    if (resumeBanner) resumeBanner.hidden = true;
    if (resumeBannerText) resumeBannerText.textContent = '';
}

function showResumeBanner(target) {
    pendingResumeTarget = target;
    if (!resumeBanner || !resumeBannerText) return;
    const place = target.label
        ? `"${target.label}" (block ${target.blockIndex + 1})`
        : `block ${target.blockIndex + 1}`;
    resumeBannerText.textContent =
        'Saved reading position found for this file: ' + place +
        '. Resume continues without starting audio automatically.';
    resumeBanner.hidden = false;
}

async function hashDocumentIdentity(file, format, buffer, identityGeneration) {
    const hex = await hexDigestFromBuffer(buffer);
    if (identityGeneration !== documentIdentityGeneration) return null;
    return {
        documentId: documentIdFromDigest(hex),
        name: file.name,
        size: Number.isFinite(file.size) ? file.size : 0,
        format,
        identityGeneration,
    };
}

function commitDocumentIdentity(candidate, priorRevision = 0) {
    if (!candidate || candidate.identityGeneration !== documentIdentityGeneration) {
        return false;
    }
    clearTimeout(progressSaveTimer);
    progressSaveTimer = null;
    currentDocumentMeta = {
        documentId: candidate.documentId,
        name: candidate.name,
        size: candidate.size,
        format: candidate.format,
        progressRevision: priorRevision + 1,
        openGeneration: ++documentOpenGeneration,
    };
    return true;
}

/** Open without durable resume when hashing fails; reject superseded hashes. */
function commitOrSkipDocumentIdentity(identity, priorRevision, identityGeneration) {
    if (identity && commitDocumentIdentity(identity, priorRevision)) return true;
    if (identityGeneration !== documentIdentityGeneration) return false;
    // Hash unavailable — keep the document usable without a progress identity.
    // Advance openGeneration so a later successful commit cannot reuse the
    // progressRevision/open token an in-flight resume lookup captured earlier.
    clearTimeout(progressSaveTimer);
    progressSaveTimer = null;
    currentDocumentMeta = null;
    ++documentOpenGeneration;
    return true;
}

function progressWriteStillCurrent(write) {
    return shouldPersistProgressUpdate({
        resumeDecisionPending: Boolean(pendingResumeTarget),
    }) && shouldAcceptProgressWrite({
        writeRevision: write.writeRevision,
        currentRevision: currentDocumentMeta?.progressRevision,
        writeChapterRequestId: write.writeChapterRequestId,
        currentChapterRequestId: chapterRequestId,
        writeDocumentId: write.writeDocumentId,
        currentDocumentId: currentDocumentMeta?.documentId,
    });
}

async function flushProgressSave(write, record) {
    if (!progressWriteStillCurrent(write)) return;
    try {
        await applyProgressUpsertMutation({
            record,
            getStore: () => browser.storage.local.get(null),
            setStore: (patch) => browser.storage.local.set(patch),
            removeKeys: (keys) => browser.storage.local.remove(keys),
            isCurrent: () => progressWriteStillCurrent(write),
        });
    } catch (error) {
        console.warn('Cannot persist reader progress', error);
    }
}

function scheduleProgressSave(blockIndex) {
    // Overlay init emits progress at block 0 while the resume banner is up.
    // Persisting that would clobber the saved position before the user chooses.
    // Explicit Play dismisses the banner via KOKORO_READER_RESUMED so later
    // progress is saved again.
    if (!shouldPersistProgressUpdate({ resumeDecisionPending: Boolean(pendingResumeTarget) })) {
        return;
    }
    const meta = currentDocumentMeta;
    if (!meta?.documentId) return;
    const playbackBlocks = currentChapterBlocks;
    const fingerprintBlocks = currentChapterCanonicalBlocks.length > 0
        ? currentChapterCanonicalBlocks
        : playbackBlocks;
    // Prefer the href for the in-flight or acknowledged reload — never the
    // previous subsection's href while a new continuous chapter is publishing.
    const chapterHref = lastPublishedReload?.chapterHref
        || renderedChapterHref
        || currentActiveHref;
    const write = {
        writeRevision: meta.progressRevision,
        writeChapterRequestId: chapterRequestId,
        writeDocumentId: meta.documentId,
    };
    if (!Array.isArray(playbackBlocks) || playbackBlocks.length === 0) return;
    if (!Number.isInteger(blockIndex) || blockIndex < 0 ||
        blockIndex >= playbackBlocks.length) {
        return;
    }
    let record;
    try {
        record = buildProgressRecord({
            documentId: write.writeDocumentId,
            name: meta.name,
            size: meta.size,
            format: meta.format,
            chapterHref,
            blockIndex,
            chapterFingerprint: fingerprintChapterBlocks(fingerprintBlocks),
            revision: write.writeRevision,
            updatedAt: Date.now(),
        });
    } catch (error) {
        console.warn('Skipping invalid reader progress record', error);
        return;
    }
    clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(() => {
        void flushProgressSave(write, record);
    }, 400);
}

async function clearCurrentDocumentProgress() {
    clearTimeout(progressSaveTimer);
    progressSaveTimer = null;
    const id = currentDocumentMeta?.documentId;
    hideResumeBanner();
    if (!id) return;
    // Bump revision so an in-flight flush that already passed clearTimeout
    // fails progressWriteStillCurrent and cannot restore the cleared record.
    if (currentDocumentMeta) {
        currentDocumentMeta = {
            ...currentDocumentMeta,
            progressRevision: (currentDocumentMeta.progressRevision || 0) + 1,
        };
    }
    try {
        await runExclusiveProgressMutation(async () => {
            const stored = await browser.storage.local.get(null);
            const plan = planProgressRemove(stored || {}, id);
            if (plan.set && Object.keys(plan.set).length) {
                await browser.storage.local.set(plan.set);
            }
            if (plan.remove.length) await browser.storage.local.remove(plan.remove);
        });
    } catch (error) {
        console.warn('Cannot clear reader progress', error);
    }
}

function activateFirstPlayableChapter(continuePlaying = false, forcedStartIndex = null) {
    const firstItem = chapterList.querySelector('.playable-chapter');
    if (firstItem && flatToc[0]) {
        activateChapter(flatToc[0], firstItem, continuePlaying, forcedStartIndex);
    }
}

function hideBookmarksPanel() {
    if (bookmarksPanel) bookmarksPanel.hidden = true;
    if (bookmarkListEl) bookmarkListEl.innerHTML = '';
    if (clearBookmarksButton) clearBookmarksButton.hidden = true;
}

function currentBookmarkChapterHref() {
    return lastPublishedReload?.chapterHref
        || renderedChapterHref
        || currentActiveHref
        || flatToc[0]?.href
        || null;
}

function currentBookmarkFingerprint() {
    const blocks = currentChapterCanonicalBlocks.length > 0
        ? currentChapterCanonicalBlocks
        : currentChapterBlocks;
    return fingerprintChapterBlocks(blocks);
}

function canAddBookmarkHere() {
    const blocks = currentChapterCanonicalBlocks.length > 0
        ? currentChapterCanonicalBlocks
        : currentChapterBlocks;
    return Boolean(currentDocumentMeta?.documentId) &&
        bookmarkProgressChapterRequestId === chapterRequestId &&
        Number.isInteger(lastKnownBlockIndex) &&
        lastKnownBlockIndex >= 0 &&
        Array.isArray(blocks) &&
        lastKnownBlockIndex < blocks.length;
}

function updateAddBookmarkEnabled() {
    if (addBookmarkButton) addBookmarkButton.disabled = !canAddBookmarkHere();
}

function resetBookmarkProgressFence() {
    lastKnownBlockIndex = null;
    bookmarkProgressChapterRequestId = null;
    updateAddBookmarkEnabled();
}

function appendBookmarkListItem(bookmark) {
    const li = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'nav-btn bookmark-go';
    go.textContent = bookmark.label || 'Bookmark';
    go.title = `${bookmark.chapterHref || 'chapter'} · block ${bookmark.blockIndex + 1}`;
    go.addEventListener('click', () => { goToBookmark(bookmark); });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'nav-btn bookmark-remove';
    remove.setAttribute('aria-label', 'Remove bookmark');
    remove.textContent = '×';
    remove.addEventListener('click', () => { void removeBookmark(bookmark.id); });
    li.append(go, remove);
    bookmarkListEl.appendChild(li);
}

async function refreshBookmarksPanel() {
    const documentId = currentDocumentMeta?.documentId;
    if (!documentId || !bookmarksPanel || !bookmarkListEl) {
        hideBookmarksPanel();
        return;
    }
    bookmarksPanel.hidden = false;
    let bookmarks = [];
    try {
        const stored = await browser.storage.local.get(null);
        if (currentDocumentMeta?.documentId !== documentId) return;
        bookmarks = readBookmarks(stored || {}, documentId);
    } catch (error) {
        console.warn('Cannot read reader bookmarks', error);
    }
    bookmarkListEl.innerHTML = '';
    for (const bookmark of bookmarks) appendBookmarkListItem(bookmark);
    if (clearBookmarksButton) {
        clearBookmarksButton.hidden = bookmarks.length === 0;
    }
    updateAddBookmarkEnabled();
}

async function persistBookmarkPlan(plan) {
    if (plan.set && Object.keys(plan.set).length) {
        await browser.storage.local.set(plan.set);
    }
    if (plan.remove.length) await browser.storage.local.remove(plan.remove);
}

async function addBookmarkAtCurrentPosition() {
    const meta = currentDocumentMeta;
    if (!canAddBookmarkHere() || !meta?.documentId) return;
    const chapterHref = currentBookmarkChapterHref();
    const blockIndex = lastKnownBlockIndex;
    const chapterLabel = findBookmarkTocItem(flatToc, chapterHref)?.label || 'Chapter';
    let bookmark;
    try {
        bookmark = buildBookmarkRecord({
            id: `bm_${Date.now().toString(36)}_${blockIndex}`,
            documentId: meta.documentId,
            label: `${chapterLabel} · ${blockIndex + 1}`,
            chapterHref,
            blockIndex,
            chapterFingerprint: currentBookmarkFingerprint(),
            createdAt: Date.now(),
        });
    } catch (error) {
        console.warn('Skipping invalid reader bookmark', error);
        return;
    }
    try {
        await runExclusiveProgressMutation(async () => {
            const stored = await browser.storage.local.get(null);
            const plan = planBookmarkAdd(stored || {}, bookmark);
            await persistBookmarkPlan(plan);
        });
    } catch (error) {
        console.warn('Cannot save reader bookmark', error);
        return;
    }
    await refreshBookmarksPanel();
}

async function removeBookmark(bookmarkId) {
    const documentId = currentDocumentMeta?.documentId;
    if (!documentId || !bookmarkId) return;
    try {
        await runExclusiveProgressMutation(async () => {
            const stored = await browser.storage.local.get(null);
            const plan = planBookmarkRemove(stored || {}, documentId, bookmarkId);
            await persistBookmarkPlan(plan);
        });
    } catch (error) {
        console.warn('Cannot remove reader bookmark', error);
        return;
    }
    await refreshBookmarksPanel();
}

async function clearAllBookmarksForDocument() {
    const documentId = currentDocumentMeta?.documentId;
    if (!documentId) return;
    try {
        await runExclusiveProgressMutation(async () => {
            const plan = planBookmarkClear({}, documentId);
            await persistBookmarkPlan(plan);
        });
    } catch (error) {
        console.warn('Cannot clear reader bookmarks', error);
        return;
    }
    await refreshBookmarksPanel();
}

function goToBookmark(bookmark) {
    if (!bookmark || flatToc.length === 0) return;
    hideResumeBanner();
    const item = findBookmarkTocItem(flatToc, bookmark.chapterHref);
    if (!item) {
        chapterErrorMsg.textContent =
            'That bookmark chapter is not in the current chapter list ' +
            '(try the other heading-scan setting).';
        chapterErrorMsg.hidden = false;
        return;
    }
    const itemEl = [...chapterList.querySelectorAll('.playable-chapter')]
        .find((el) => el.dataset.href === item.href);
    // Validate fingerprint after blocks load; never autoplay.
    activateChapter(item, itemEl || null, false, null, { bookmarkJump: bookmark });
}

function applyBookmarkJumpPlayback(bookmark, blocks) {
    const playback = resolveBookmarkPlayback({
        bookmark,
        flatToc,
        chapterFingerprint: fingerprintChapterBlocks(blocks),
        chapterBlockCount: blocks.length,
    });
    if (playback.outdated) {
        chapterErrorMsg.textContent =
            'Bookmark is outdated for this chapter; starting at the beginning.';
        chapterErrorMsg.hidden = false;
    }
    return playback;
}

async function offerResumeOrStart() {
    hideResumeBanner();
    const meta = currentDocumentMeta;
    const documentId = meta?.documentId;
    const openGeneration = meta?.openGeneration;
    if (!documentId || flatToc.length === 0) {
        activateFirstPlayableChapter();
        return;
    }
    let record = null;
    try {
        const stored = await browser.storage.local.get(null);
        // Same-file re-open and hash-failure clears bump openGeneration; a
        // different file changes documentId. Leave the newer commit's
        // offerResumeOrStart to drive activation. Failed/cancelled selections
        // never commit, so openGeneration stays put and this lookup proceeds.
        if (!isResumeLookupStillCurrent({
            capturedDocumentId: documentId,
            capturedOpenGeneration: openGeneration,
            currentMeta: currentDocumentMeta,
        })) return;
        record = readProgressRecord(stored || {}, documentId);
    } catch (error) {
        console.warn('Cannot read saved reader progress', error);
    }
    if (!isResumeLookupStillCurrent({
        capturedDocumentId: documentId,
        capturedOpenGeneration: openGeneration,
        currentMeta: currentDocumentMeta,
    })) return;
    if (!record) {
        activateFirstPlayableChapter();
        return;
    }
    const href = record.chapterHref || flatToc[0].href;
    const item = flatToc.find((entry) => entry.href === href) || flatToc[0];
    const itemEl = [...chapterList.querySelectorAll('.playable-chapter')]
        .find((el) => el.dataset.href === item.href);
    // Load the saved chapter at index 0 (no autoplay). After blocks are ready,
    // validate fingerprint/range and offer Resume without unexpected audio.
    activateChapter(item, itemEl || null, false, 0, { resumeCandidate: record });
}

function resetPickerState() {
    fileInput.value = '';
    if (fileNameDisplay) fileNameDisplay.textContent = 'No file selected.';
    errorMsg.style.display = 'none';
    errorMsg.textContent = '';
    loadingStatus.style.display = 'none';
    cancelDocumentPickerButton.hidden = !hasOpenDocument();
}

function openDocumentPicker() {
    resetPickerState();
    clearPickerDragState();
    filePickerOverlay.style.display = 'flex';
}

function resumeAutoplayForNewDocument() {
    if (!readerPausedForPicker) return;
    readerPausedForPicker = false;
    // An explicit successful document replacement restores its autoplay preference.
    playerFrame.contentWindow.postMessage('RESUME_READER_AUTOPLAY', window.location.origin);
}

function cancelDocumentPicker() {
    if (filePickerOverlay.style.display === 'none' || !hasOpenDocument()) return;
    // Never leave the first-load reader empty; once a new text chapter commits
    // and closes the picker, Cancel can no longer roll it back.
    // Cancel an in-flight file read or EPUB open/TOC scan without altering
    // the already committed chapter/player, even if old promises settle later.
    ++fileRequestId;
    ++documentIdentityGeneration;
    if (activeFileReader && activeFileReader.readyState === FileReader.LOADING &&
        typeof activeFileReader.abort === 'function') {
        activeFileReader.abort();
    }
    resetPickerState();
    clearPickerDragState();
    filePickerOverlay.style.display = 'none';
    if (deferredChapterEndRevision !== null) {
        continueAfterChapter(deferredChapterEndRevision);
    }
}

openAnotherDocumentButton.addEventListener('click', openDocumentPicker);
cancelDocumentPickerButton.addEventListener('click', cancelDocumentPicker);
window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && filePickerOverlay.style.display !== 'none') {
        cancelDocumentPicker();
    }
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
});

// Drag and Drop Handling — highlight the full picker overlay (#17), not only
// the dashed drop card. Depth counting ignores child enter/leave flicker.
let pickerDragDepth = 0;

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function setPickerDragActive(active) {
    filePickerOverlay.classList.toggle('drag-active', active);
    dropZone.classList.toggle('drag-active', active);
}

function clearPickerDragState() {
    pickerDragDepth = 0;
    setPickerDragActive(false);
}

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    filePickerOverlay.addEventListener(eventName, preventDefaults, false);
});

filePickerOverlay.addEventListener('dragenter', () => {
    pickerDragDepth += 1;
    setPickerDragActive(true);
}, false);

filePickerOverlay.addEventListener('dragleave', () => {
    pickerDragDepth = Math.max(0, pickerDragDepth - 1);
    if (pickerDragDepth === 0) setPickerDragActive(false);
}, false);

filePickerOverlay.addEventListener('drop', (e) => {
    pickerDragDepth = 0;
    setPickerDragActive(false);
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
}, false);

async function handleFile(file) {
    const requestId = ++fileRequestId;
    // Aborting abandoned reads prevents large EPUB buffers from accumulating
    // when a second file is selected before the first read completes.
    if (activeFileReader && activeFileReader.readyState === FileReader.LOADING &&
        typeof activeFileReader.abort === 'function') {
        activeFileReader.abort();
    }
    errorMsg.style.display = 'none';
    loadingStatus.textContent = 'Loading document...';
    loadingStatus.style.display = 'block';

    if (fileNameDisplay) fileNameDisplay.textContent = file.name;

    try {
        const format = detectDocumentFormat(file);
        if (format === 'epub') await loadEpub(file, requestId);
        else await loadTextDocument(file, format, requestId);
        // Only a successfully parsed and current document may hide the picker.
        if (requestId === fileRequestId) {
            clearPickerDragState();
            filePickerOverlay.style.display = 'none';
            cancelDocumentPickerButton.hidden = !hasOpenDocument();
        }
    } catch (err) {
        if (requestId !== fileRequestId) return;
        console.error('Document loading failed:', err);
        errorMsg.textContent = 'Failed to load document: ' + String(err.message || err);
        errorMsg.style.display = 'block';
    } finally {
        if (requestId === fileRequestId) loadingStatus.style.display = 'none';
    }
}

document.getElementById('toggleSidebar').addEventListener('click', () => {
    appContainer.classList.add('sidebar-hidden');
    const showButton = document.getElementById('showSidebarBtn');
    showButton.style.display = 'block';
    showButton.focus();
});

document.getElementById('showSidebarBtn').addEventListener('click', () => {
    appContainer.classList.remove('sidebar-hidden');
    document.getElementById('showSidebarBtn').style.display = 'none';
    document.getElementById('toggleSidebar').focus();
});

// EPUB.js preserves raw navigation hrefs, which are relative to the
// navigation (or NCX) file, while Spine.get() expects OPF-relative hrefs.
// Normalize links only to actual spine sections, preserving order, labels,
// hierarchy, and fragments. Unresolvable/external paths stay non-playable.
function normalizePublisherToc(items, sourceBook) {
    const navPath = sourceBook.packaging?.navPath || sourceBook.packaging?.ncxPath;
    const origin = 'https://epub.invalid/';
    const base = navPath ? new URL(navPath.replace(/^\/+/, ''), origin) : null;
    const normalize = item => {
        let href = '';
        if (typeof item.href === 'string' && item.href.trim()) {
            const raw = item.href.trim();
            const hash = raw.indexOf('#');
            const path = hash < 0 ? raw : raw.slice(0, hash);
            const fragment = hash < 0 ? '' : raw.slice(hash);
            // Interpret hrefs relative to the EPUB navigation document first.
            // Otherwise "chapter.xhtml" can wrongly select a root-level
            // chapter instead of "Nav/chapter.xhtml". A fragment-only href
            // targets the nav document itself when that file is in the spine.
            let section = null;
            if (base) {
                try {
                    const resolved = new URL(path || '', base);
                    if (resolved.origin === base.origin) {
                        section = sourceBook.spine.get(
                            decodeURIComponent(resolved.pathname.slice(1)));
                    }
                } catch (error) {
                    console.warn('Ignoring invalid publisher TOC path', path, error);
                }
            }
            // Some EPUB manifests use already-OPF-relative links; accept
            // those when the navigation-relative target is not a spine item.
            if (!section && path && !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
                !path.startsWith('//')) {
                section = sourceBook.spine.get(path);
            }
            if (section) href = section.href + fragment;
        }
        return {
            ...item,
            href,
            subitems: (item.subitems || item.items || []).map(normalize),
        };
    };
    return items.map(normalize);
}

function hasPlayableTocEntry(items) {
    return items.some(item => Boolean(item.href) ||
        hasPlayableTocEntry(item.subitems || item.items || []));
}

// EPUB publisher TOC fragments may be URI-encoded even though the extracted
// DOM element IDs are Unicode strings. Keep malformed escapes as literals so
// a corrupt anchor cannot crash either chapter loading or progress syncing.
function decodedChapterId(fragment) {
    try {
        return decodeURIComponent(fragment);
    } catch (error) {
        console.warn('Invalid EPUB chapter fragment encoding', fragment, error);
        return fragment;
    }
}

// --- EPUB Logic ---

async function readDocumentBuffer(file) {
    const reader = new FileReader();
    activeFileReader = reader;
    try {
        return await new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('Cannot read file'));
            reader.onabort = () => reject(new DOMException('File read cancelled', 'AbortError'));
            try {
                reader.readAsArrayBuffer(file);
            } catch (error) {
                reject(error);
            }
        });
    } finally {
        if (activeFileReader === reader) activeFileReader = null;
    }
}

async function resolveEpubToc(candidate, requestId) {
    const publisherToc = candidate.navigation?.toc || [];
    // The EPUB's own navigation is authoritative. Heading scanning is an
    // opt-in alternative, except for books without a publisher TOC.
    const scan = scanDocumentHeadings.checked || publisherToc.length === 0;
    if (scan) loadingStatus.textContent = 'Scanning for chapters...';
    const discovered = scan
        ? await getEnrichedToc(candidate, () => requestId === fileRequestId)
        : publisherToc;
    if (requestId !== fileRequestId) return null;
    // Heading-scan links come from Section.href and are already relative
    // to the OPF. Do not resolve them against the nav document again:
    // same-name chapters in different directories would be conflated.
    // If no headings were found, the scanner returns the original
    // publisher array by identity; those raw links still need resolving.
    const toc = scan && discovered !== publisherToc
        ? discovered
        : normalizePublisherToc(discovered, candidate);
    if (!hasPlayableTocEntry(toc)) throw new Error('EPUB contains no readable chapters');
    return toc;
}

function commitOpenedEpub(candidate, toc) {
    const oldBook = book;
    chapterRequestId++;
    book = candidate;
    textDocument = null;
    deferredChapterEndRevision = null;
    if (oldBook) retiringBooks.add(oldBook);
    currentChapterBlocks = [];
    currentChapterCanonicalBlocks = [];
    currentActiveHref = null;
    currentToc = toc;
    resumeAutoplayForNewDocument();
    renderChapterList(toc, { autoActivate: false });
}

async function loadEpub(file, requestId) {
    const bookData = await readDocumentBuffer(file);
    if (requestId !== fileRequestId) return;
    if (!(bookData instanceof ArrayBuffer)) {
        throw new Error('EPUB file did not contain binary data');
    }
    // Hash in parallel with open/TOC so identity is ready for resume without
    // delaying EPUB.js construction (and without changing first-tick open race tests).
    // Do not assign currentDocumentMeta until the candidate is committed.
    const identityGeneration = ++documentIdentityGeneration;
    const priorProgressRevision = currentDocumentMeta?.progressRevision || 0;
    const identityPromise = hashDocumentIdentity(
        file, 'epub', bookData, identityGeneration).catch((error) => {
        console.warn('Cannot hash document for reader progress', error);
        return null;
    });

    // Keep the existing book and player intact until the replacement has
    // parsed successfully. Failed selections must not destroy a working book.
    // EPUB.js constructor-triggered open failures emit "openFailed" without
    // rejecting book.ready. Construct an unopened book and await open() itself:
    // invalid ZIP/container/package errors then reject into handleFile().
    const candidate = ePub();
    let committed = false;
    try {
        await candidate.open(bookData);
        await candidate.ready;
        if (requestId !== fileRequestId) return;

        const toc = await resolveEpubToc(candidate, requestId);
        if (!toc || requestId !== fileRequestId) return;

        const identity = await identityPromise;
        if (requestId !== fileRequestId) return;
        if (!commitOrSkipDocumentIdentity(
            identity, priorProgressRevision, identityGeneration)) return;

        commitOpenedEpub(candidate, toc);
        committed = true;
        resetBookmarkProgressFence();
        await offerResumeOrStart();
        await refreshBookmarksPanel();
    } finally {
        // A failed/superseded candidate must not retain its ZIP and section
        // documents. Only the successfully committed book remains owned here.
        if (!committed) disposeBook(candidate);
    }
}

// Non-EPUB formats, including DOCX, use a single synthetic chapter and the same
// sendToPlayer() storage/iframe path as EPUB. No fake EPUB.js Book is created.
async function loadTextDocument(file, format, requestId) {
    const sizeLimit = format === 'docx' ? MAX_DOCX_ARCHIVE_BYTES : MAX_TEXT_DOCUMENT_BYTES;
    if (Number.isFinite(file.size) && file.size > sizeLimit) {
        throw new Error(format === 'docx'
            ? 'DOCX files larger than 24 MiB are not supported'
            : 'Text documents larger than 4 MiB are not supported');
    }
    const bytes = await readDocumentBuffer(file);
    if (requestId !== fileRequestId) return;
    const identityGeneration = ++documentIdentityGeneration;
    const priorProgressRevision = currentDocumentMeta?.progressRevision || 0;
    const identityPromise = hashDocumentIdentity(
        file, format, bytes, identityGeneration).catch((error) => {
        console.warn('Cannot hash document for reader progress', error);
        return null;
    });
    const blocks = format === 'docx'
        ? await parseDocxDocument(bytes)
        : parseTextDocument(format, decodeTextDocument(bytes));
    if (requestId !== fileRequestId) return;
    const identity = await identityPromise;
    if (requestId !== fileRequestId) return;
    if (!commitOrSkipDocumentIdentity(
        identity, priorProgressRevision, identityGeneration)) return;

    // Preserve the existing EPUB if reading/parsing fails, and hand its image
    // URLs over only after the text chapter has rendered in the iframe.
    const oldBook = book;
    chapterRequestId++;
    book = null;
    textDocument = { blocks, title: file.name };
    deferredChapterEndRevision = null;
    if (oldBook) retiringBooks.add(oldBook);
    currentChapterBlocks = blocks;
    currentChapterCanonicalBlocks = blocks;
    currentActiveHref = null;
    currentToc = [{ href: 'document:0', label: file.name }];
    resumeAutoplayForNewDocument();
    renderChapterList(currentToc, { autoActivate: false });
    resetBookmarkProgressFence();
    await offerResumeOrStart();
    await refreshBookmarksPanel();
    // Parsing and rendering the chapter list commit the replacement. The
    // async player write must *not* keep Cancel visible after this point.
    // Subsequent storage failures are reported by startTextChapterLoad() in
    // the reader's visible alert, without rolling back a committed document.
}

async function startTextChapterLoad(title, forcedStartIndex = null, resumeCandidate = null,
    bookmarkJump = null) {
    const source = textDocument;
    const requestId = ++chapterRequestId;
    resetBookmarkProgressFence();
    chapterErrorMsg.hidden = true;
    chapterErrorMsg.textContent = '';
    if (!source) return;
    try {
        let startIndex = Number.isInteger(forcedStartIndex) ? forcedStartIndex : 0;
        let suppressAutoplay = Boolean(resumeCandidate) ||
            Number.isInteger(forcedStartIndex) || Boolean(bookmarkJump);
        if (resumeCandidate && forcedStartIndex === 0 && !bookmarkJump) {
            const target = resolveResumeTarget({
                record: resumeCandidate,
                flatToc,
                chapterFingerprint: fingerprintChapterBlocks(source.blocks),
                chapterBlockCount: source.blocks.length,
            });
            if (shouldOfferResumeChoice(target, flatToc[0]?.href)) {
                showResumeBanner(target);
                startIndex = 0;
            } else if (!target.ok) {
                void clearCurrentDocumentProgress();
            }
        }
        if (bookmarkJump) {
            const playback = applyBookmarkJumpPlayback(bookmarkJump, source.blocks);
            startIndex = playback.startIndex;
            suppressAutoplay = playback.suppressAutoplay;
        }
        await sendToPlayer(source.blocks, title || source.title,
            source.blocks.map(entry => entry.content).join(' ').slice(0, 100),
            startIndex, requestId, null, false, currentToc[0]?.href || 'document:0',
            { suppressAutoplay });
    } catch (error) {
        if (source !== textDocument || requestId !== chapterRequestId) return;
        chapterErrorMsg.textContent = 'Failed to load document: ' + String(error.message || error);
        chapterErrorMsg.hidden = false;
        throw error;
    }
}

/**
 * Scans the spine for sections not in the TOC and attempts to discover subchapters by parsing headings.
 */
async function getEnrichedToc(book, isCurrent = () => true) {
    const originalToc = book.navigation.toc;
    const spine = book.spine;

    // Map of href (no hash) -> label from original TOC
    const tocMap = new Map();
    const collectHrefs = (items) => {
        items.forEach(item => {
            if (item.href) {
                const base = item.href.split('#')[0];
                tocMap.set(base, item.label.trim());
            }
            const children = item.subitems || item.items || [];
            collectHrefs(children);
        });
    };
    collectHrefs(originalToc);

    const enriched = [];
    let currentMain = null;

    for (let i = 0; i < spine.length; i++) {
        if (!isCurrent()) return [];
        const section = spine.get(i);
        const href = section.href;

        try {
            const doc = await section.load(book.load.bind(book));
            if (!isCurrent()) return [];
            const headings = doc.querySelectorAll('h1, h2, h3');

            if (headings.length === 0) {
                if (tocMap.has(href)) {
                    const label = tocMap.get(href);
                    if (!enriched.some(e => e.label === label)) {
                        currentMain = { label, href, subitems: [] };
                        enriched.push(currentMain);
                    }
                }
                continue;
            }

            for (const h of headings) {
                const tagName = h.tagName.toLowerCase();
                const label = h.textContent.trim();
                if (!label) continue;

                // Find best ID for this heading
                let foundId = h.id;

                // Check preceding element for anchor with ID (common in EPUB)
                if (!foundId && h.previousElementSibling && h.previousElementSibling.tagName.toLowerCase() === 'a' && h.previousElementSibling.id) {
                    foundId = h.previousElementSibling.id;
                }
                if (!foundId && h.previousElementSibling && h.previousElementSibling.tagName.toLowerCase() === 'div' && h.previousElementSibling.id && !h.previousElementSibling.textContent.trim()) {
                    foundId = h.previousElementSibling.id;
                }

                if (!foundId) {
                    foundId = h.querySelector('[id]')?.id;
                }

                if (!foundId) {
                    // Only climb up if we don't have a better option
                    let target = h.parentElement;
                    while (target && target !== doc.body && !target.id) {
                        target = target.parentElement;
                    }
                    if (target && target.id) {
                        // Only use parent ID if this heading is near the top of that container
                        // and no other heading has claimed it yet.
                        foundId = target.id;
                    }
                }

                const itemHref = foundId ? `${href}#${foundId}` : href;

                if (tagName === 'h1' || tagName === 'h2') {
                    currentMain = { label, href: itemHref, subitems: [] };
                    enriched.push(currentMain);
                } else if (tagName === 'h3' && currentMain) {
                    currentMain.subitems.push({ label, href: itemHref });
                }
            }
        } catch (e) {
            if (!isCurrent()) return [];
            console.warn("Failed to scan section", href, e);
            if (tocMap.has(href)) {
                const label = tocMap.get(href);
                if (!enriched.some(e => e.label === label)) {
                    currentMain = { label, href, subitems: [] };
                    enriched.push(currentMain);
                }
            }
        } finally {
            // TOC scanning visits every spine section. EPUB.js retains each
            // parsed document until Section.unload() is called.
            section.unload?.();
        }
    }

    return enriched.length > 0 ? enriched : originalToc;
}

// Buttons make both chapter selection and TOC expansion operable by keyboard
// without nesting interactive controls or requiring custom key handling.
function setChapterGroupExpanded(group, expanded) {
    group.classList.toggle('expanded', expanded);
    const toggle = group.firstElementChild?.querySelector('.chapter-toggle');
    if (toggle) {
        toggle.textContent = expanded ? '▼' : '▶';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-label',
            (expanded ? 'Collapse ' : 'Expand ') + (toggle.dataset.label || 'chapter group'));
    }
}

function selectActiveChapter(href) {
    let selected = null;
    chapterList.querySelectorAll('.playable-chapter').forEach(button => {
        const active = button.dataset.href === href;
        button.classList.toggle('active', active);
        button.closest('.chapter-item')?.classList.toggle('active', active);
        if (active) {
            button.setAttribute('aria-current', 'true');
            selected = button;
        } else {
            button.removeAttribute('aria-current');
        }
    });
    return selected;
}

function renderChapterList(toc, options = {}) {
    const autoActivate = options.autoActivate !== false;
    chapterList.innerHTML = '';
    flatToc = [];
    let subListId = 0;

    const createItem = (item, level = 0) => {
        const playable = Boolean(item.href);
        if (playable) flatToc.push(item);
        const container = document.createElement('div');
        container.className = 'chapter-group';
        if (level > 0) container.classList.add('subchapter-list');

        const itemEl = document.createElement('div');
        itemEl.className = 'chapter-item';
        if (!playable) itemEl.classList.add('chapter-group-label');
        itemEl.style.paddingLeft = `${10 + (level * 20)}px`;

        const children = item.subitems || item.items || [];
        const hasChildren = children.length > 0;

        let subList;
        if (hasChildren) {
            subList = document.createElement('div');
            subList.className = 'sub-items';
            subList.id = `reader-subitems-${++subListId}`;

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'chapter-toggle';
            toggle.dataset.label = (item.label || 'Untitled').trim();
            toggle.setAttribute('aria-controls', subList.id);
            itemEl.appendChild(toggle);
            toggle.addEventListener('click', () => {
                setChapterGroupExpanded(container, !container.classList.contains('expanded'));
            });
        } else if (level > 0) {
            const spacer = document.createElement('span');
            spacer.className = 'chapter-spacer';
            spacer.setAttribute('aria-hidden', 'true');
            itemEl.appendChild(spacer);
        }

        const label = document.createElement('span');
        label.className = 'chapter-label';
        label.textContent = (item.label || "Untitled").trim();

        if (playable) {
            const chapterButton = document.createElement('button');
            chapterButton.type = 'button';
            chapterButton.className = 'chapter-select playable-chapter';
            chapterButton.dataset.href = item.href;
            chapterButton.appendChild(label);
            chapterButton.addEventListener('click', () => {
                hideResumeBanner();
                activateChapter(item, chapterButton);
            });
            itemEl.appendChild(chapterButton);
        } else {
            itemEl.appendChild(label);
        }

        container.appendChild(itemEl);
        chapterList.appendChild(container);
        if (subList) setChapterGroupExpanded(container, false);

        if (subList) {
            children.forEach(sub => subList.appendChild(createItem(sub, level + 1)));
            container.appendChild(subList);
        }

        return container;
    };

    toc.forEach(item => createItem(item));
    // No chapter is active yet: keep Prev/Next disabled until activation below
    // sets currentActiveHref. Relying on a synthetic .click() alone can leave
    // Next disabled if the listener fails to run for a detached/replaced node.
    updateNavButtons();

    // Expand parent TOC groups of the selected chapter, including when
    // a non-linked group label contains the first playable chapter.
    const firstItem = chapterList.querySelector('.playable-chapter');
    if (autoActivate && firstItem && flatToc[0]) {
        // Activate through the same path as a user click, but call the
        // handler directly so first-chapter Prev/Next state cannot depend on
        // dispatching a DOM click against a just-mounted button.
        activateChapter(flatToc[0], firstItem);
        let group = firstItem.closest('.chapter-group');
        while (group && chapterList.contains(group)) {
            setChapterGroupExpanded(group, true);
            group = group.parentElement?.closest('.chapter-group');
        }
    } else if (firstItem) {
        let group = firstItem.closest('.chapter-group');
        while (group && chapterList.contains(group)) {
            setChapterGroupExpanded(group, true);
            group = group.parentElement?.closest('.chapter-group');
        }
    }
}

function activateChapter(item, itemEl, continuePlaying = false, forcedStartIndex = null,
    options = {}) {
    if (!item?.href) return;
    selectActiveChapter(item.href);
    currentActiveHref = item.href;
    updateNavButtons();
    if (book) {
        startChapterLoad(item.href, item.label, continuePlaying, forcedStartIndex, options);
    } else if (textDocument) {
        activeTextChapterWrite = startTextChapterLoad(
            item.label, forcedStartIndex, options.resumeCandidate || null,
            options.bookmarkJump || null);
        // The reader alert carries errors; avoid unhandled rejections.
        void activeTextChapterWrite.catch(() => {});
    }
}

// Register chapter navigation exactly once. Re-rendering a TOC for another
// EPUB must not accumulate handlers (which would trigger duplicate loads).
prevChapterBtn.addEventListener('click', () => {
    const index = flatToc.findIndex(item => item.href === currentActiveHref);
    if (index > 0) {
        const item = flatToc[index - 1];
        const el = [...chapterList.querySelectorAll('.playable-chapter')]
            .find(node => node.dataset.href === item.href);
        el?.click();
    }
});
nextChapterBtn.addEventListener('click', () => {
    const index = flatToc.findIndex(item => item.href === currentActiveHref);
    if (index !== -1 && index < flatToc.length - 1) {
        const item = flatToc[index + 1];
        const el = [...chapterList.querySelectorAll('.playable-chapter')]
            .find(node => node.dataset.href === item.href);
        el?.click();
    }
});

function updateNavButtons() {
    const currentIndex = flatToc.findIndex(item => item.href === currentActiveHref);
    // Treat a missing/unmatched selection like the start of the list for Prev
    // (disabled), but keep Next disabled until a real flatToc entry is active.
    // Empty TOCs and single-chapter documents must not leave the HTML default
    // enabled state visible after renderChapterList().
    const atOrBeforeFirst = currentIndex <= 0;
    const atOrPastLast = currentIndex === -1 || currentIndex >= flatToc.length - 1;
    prevChapterBtn.disabled = atOrBeforeFirst;
    nextChapterBtn.disabled = atOrPastLast;
    prevChapterBtn.setAttribute('aria-disabled', String(prevChapterBtn.disabled));
    nextChapterBtn.setAttribute('aria-disabled', String(nextChapterBtn.disabled));
}

// A prior book may still have section.load() in progress when its successor
// is selected. Track chapter work so Book.destroy() waits for those readers.
function startChapterLoad(href, title, continuePlaying = false, forcedStartIndex = null,
    options = {}) {
    const source = book;
    // The file picker is hidden after successful EPUB loading; chapter errors
    // must be shown in the reader, not in the hidden file picker.
    chapterErrorMsg.hidden = true;
    chapterErrorMsg.textContent = '';
    const task = loadEpubChapter(href, title, continuePlaying, forcedStartIndex, options);
    const requestId = chapterRequestId;
    let tasks = chapterTasks.get(source);
    if (!tasks) {
        tasks = new Set();
        chapterTasks.set(source, tasks);
    }
    tasks.add(task);
    void task.catch(error => {
        if (book !== source || requestId !== chapterRequestId) return;
        console.error('EPUB chapter could not be loaded:', error);
        chapterErrorMsg.textContent = 'Failed to load chapter: ' + String(error.message || error);
        chapterErrorMsg.hidden = false;
    }).finally(() => {
        tasks.delete(task);
        if (tasks.size === 0) chapterTasks.delete(source);
    });
}

// EPUB.js 0.3.93 Archive.destroy() revokes the cache *keys* (EPUB paths),
// rather than the cached blob URL values. Explicitly release the real URLs
// before destroying a retired archive, without touching data: resources.
function disposeBook(sourceBook) {
    if (!sourceBook) return;
    const cache = sourceBook.archive?.urlCache;
    if (cache && typeof URL.revokeObjectURL === 'function') {
        for (const url of new Set(Object.values(cache))) {
            if (typeof url !== 'string' || !url.startsWith('blob:')) continue;
            try {
                URL.revokeObjectURL(url);
            } catch (error) {
                console.warn('Unable to revoke EPUB image URL', error);
            }
        }
    }
    sourceBook.destroy?.();
}

function releaseRetiredBooks() {
    for (const previous of retiringBooks) {
        retiringBooks.delete(previous);
        const tasks = [...(chapterTasks.get(previous) || [])];
        void Promise.allSettled(tasks).then(() => {
            try {
                disposeBook(previous);
            } catch (error) {
                console.warn('Unable to release previous EPUB archive', error);
            }
        });
    }
}

// Section.load() caches the DOM. Different overlapping chapter selections can
// share one Section, so unload it only after the last reader completes.
async function consumeSection(section, source, callback) {
    sectionUsers.set(section, (sectionUsers.get(section) || 0) + 1);
    try {
        const doc = await section.load(source.load.bind(source));
        return await callback(doc);
    } finally {
        const remaining = (sectionUsers.get(section) || 1) - 1;
        if (remaining > 0) sectionUsers.set(section, remaining);
        else {
            sectionUsers.delete(section);
            section.unload?.();
        }
    }
}

async function loadEpubChapter(href, title, continuePlaying = false, forcedStartIndex = null,
    options = {}) {
    const requestId = ++chapterRequestId;
    resetBookmarkProgressFence();
    const requestedBook = book;
    if (!requestedBook) return;
    const spine = requestedBook.spine;
    const [baseHref, fragment] = href.split('#');
    const startSection = spine.get(baseHref);
    if (!startSection) return;

    // We want to load all sections from startSection until the next EXPLICIT TOC entry
    const tocHrefs = new Set();
    const collectHrefs = (items) => {
        items.forEach(item => {
            if (item.href) tocHrefs.add(item.href.split('#')[0]);
            const children = item.subitems || item.items || [];
            collectHrefs(children);
        });
    };
    // currentToc has the publisher's hrefs normalized to spine paths.
    // Raw EPUB navigation hrefs may otherwise miss chapter boundaries.
    collectHrefs(currentToc);

    const sectionsToLoad = [startSection];
    let nextIdx = startSection.index + 1;
    while (nextIdx < spine.length) {
        const nextSec = spine.get(nextIdx);
        // Stop if this section starts a new TOC chapter/subchapter
        if (tocHrefs.has(nextSec.href)) break;
        sectionsToLoad.push(nextSec);
        nextIdx++;
    }

    const allBlocks = [];
    for (const sec of sectionsToLoad) {
        const blocks = await consumeSection(sec, requestedBook, async doc => {
            if (requestId !== chapterRequestId || book !== requestedBook) return null;
            const body = doc.body || (doc.documentElement ? doc.documentElement : doc);
            const result = await extractBlocks(sec, body, requestedBook);
            if (requestId !== chapterRequestId || book !== requestedBook) return null;
            return result;
        });
        if (!blocks) return; // superseded chapter; section already unloaded
        allBlocks.push(...blocks);
    }

    // Merge continuations across blocks
    const mergedBlocks = [];
    for (const b of allBlocks) {
        if (b.type === 'text' && mergedBlocks.length > 0 && mergedBlocks[mergedBlocks.length - 1].type === 'text') {
            const last = mergedBlocks[mergedBlocks.length - 1];
            const lastText = last.content.trim();
            const currText = b.content.trim();

            if (lastText && currText) {
                const endsInNoPunct = !/[.!?!"”']$/.test(lastText);
                const startsLower = /^[a-z]/.test(currText);
                if (endsInNoPunct || startsLower) {
                    last.content += ' ' + b.content;
                    last.html += ' ' + b.html;
                    if (b.ids && b.ids.length > 0) {
                        last.ids = [...new Set([...(last.ids || []), ...b.ids])];
                    }
                    continue;
                }
            }
        }
        mergedBlocks.push(b);
    }

    if (requestId !== chapterRequestId || book !== requestedBook) return;
    currentChapterBlocks = mergedBlocks;
    // Fingerprint the full section set so continuous-reader truncation cannot
    // invalidate an otherwise valid saved position for the same file.
    currentChapterCanonicalBlocks = mergedBlocks;

    // baseHref and fragment are already defined at the start of the function
    let startIndex = 0;
    let suppressAutoplay = false;

    if (Number.isInteger(forcedStartIndex) && forcedStartIndex >= 0) {
        startIndex = Math.min(forcedStartIndex, Math.max(0, mergedBlocks.length - 1));
        suppressAutoplay = true;
    } else if (fragment) {
        const targetId = decodedChapterId(fragment);
        const idx = mergedBlocks.findIndex(b => b.ids && b.ids.includes(targetId));
        if (idx !== -1) {
            startIndex = idx;
            console.log("Found fragment at block index:", idx);
        } else {
            console.warn('Fragment not found in chapter:', fragment);
            // This is a fallback to the start of the chapter, not a successful
            // anchor navigation. Report it in the reader, not the hidden picker.
            chapterErrorMsg.textContent =
                'The requested chapter anchor could not be found. Playback starts at the chapter beginning.';
            chapterErrorMsg.hidden = false;
        }
    }

    if (options.resumeCandidate && !options.bookmarkJump) {
        const target = resolveResumeTarget({
            record: options.resumeCandidate,
            flatToc,
            chapterFingerprint: fingerprintChapterBlocks(mergedBlocks),
            chapterBlockCount: mergedBlocks.length,
        });
        if (shouldOfferResumeChoice(target, flatToc[0]?.href)) {
            showResumeBanner(target);
            startIndex = 0;
            suppressAutoplay = true;
        } else if (!target.ok) {
            void clearCurrentDocumentProgress();
        }
    }

    if (options.bookmarkJump) {
        const playback = applyBookmarkJumpPlayback(options.bookmarkJump, mergedBlocks);
        startIndex = playback.startIndex;
        suppressAutoplay = playback.suppressAutoplay;
    }

    const fullText = mergedBlocks.map(b => b.content).join(' ');
    await sendToPlayer(mergedBlocks, title || "Chapter", fullText.substring(0, 100), startIndex,
        requestId, requestedBook, continuePlaying, href, { suppressAutoplay });
}

// --- Content Processing & Extraction ---

async function extractBlocks(section, bodyElement, sourceBook = book) {
    if (!bodyElement) return [];

    // 1. Resolve images
    if (typeof bodyElement.querySelectorAll === 'function') {
        const images = bodyElement.querySelectorAll('img');
        for (const img of images) {
            const src = img.getAttribute('src');
            if (src && sourceBook) {
                try {
                    // Resolve relative path within the selected EPUB
                    const baseUrl = new URL(section.url || section.href, "http://temp/").href;
                    const absolutePath = new URL(src, baseUrl).pathname;
                    const url = await sourceBook.archive.createUrl(absolutePath);
                    img.src = url;
                } catch (e) {
                    console.warn("Failed to resolve image", src, e);
                }
            }
        }
    }

    // 2. Extract raw blocks
    const blocks = [];
    const usedIds = new Set();
    let pendingIds = [];

    function walk(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();
            if (['script', 'style', 'noscript'].includes(tagName)) return;

            // Collect ID if present and not yet used
            if (node.id && !usedIds.has(node.id)) {
                pendingIds.push(node.id);
                usedIds.add(node.id);
            }

            // Also collect 'name' attribute which is common in older EPUBs (especially from Word)
            const nameAttr = node.getAttribute('name');
            if (nameAttr && !usedIds.has(nameAttr)) {
                pendingIds.push(nameAttr);
                usedIds.add(nameAttr);
            }

            if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote'].includes(tagName)) {
                // Collect IDs/names from children too
                const descendantWithIds = node.querySelectorAll('[id], [name]');
                descendantWithIds.forEach(el => {
                    const id = el.id || el.getAttribute('name');
                    if (id && !usedIds.has(id)) {
                        pendingIds.push(id);
                        usedIds.add(id);
                    }
                });

                blocks.push({
                    type: (tagName === 'p' || tagName === 'li' || tagName === 'blockquote') ? 'text' : tagName,
                    ids: [...pendingIds],
                    html: node.innerHTML,
                    content: node.textContent.trim()
                });
                pendingIds = []; // Reset after assigning to a block
            } else if (tagName === 'img') {
                blocks.push({ type: 'image', src: node.src, ids: [...pendingIds] });
                pendingIds = [];
            } else {
                for (const child of node.childNodes) {
                    walk(child);
                }
            }
        } else if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text && node.parentElement === bodyElement) {
                blocks.push({ type: 'text', content: text, html: text, ids: [...pendingIds] });
                pendingIds = [];
            }
        }
    }
    walk(bodyElement);

    // Fallback for reader.js legacy: also provide a single 'id' property (the first one)
    blocks.forEach(b => {
        if (b.ids && b.ids.length > 0) {
            b.id = b.ids[0];
        } else {
            b.id = "";
        }
    });

    return blocks;
}

// --- Bi-directional Sync ---

window.addEventListener('message', (event) => {
    if (event.source !== playerFrame.contentWindow ||
        event.origin !== window.location.origin ||
        event.data?.type !== 'KOKORO_READING_PROGRESS') {
        return;
    }
    const blockIndex = event.data.blockIndex;
    if (Number.isInteger(blockIndex) && blockIndex >= 0) {
        lastKnownBlockIndex = blockIndex;
        bookmarkProgressChapterRequestId = chapterRequestId;
        updateAddBookmarkEnabled();
    }
    updateActiveChapter(blockIndex);
    scheduleProgressSave(blockIndex);
});

addBookmarkButton?.addEventListener('click', () => {
    void addBookmarkAtCurrentPosition();
});

clearBookmarksButton?.addEventListener('click', () => {
    void clearAllBookmarksForDocument();
});

resumeReadingButton?.addEventListener('click', () => {
    const target = pendingResumeTarget;
    if (!target || !Number.isInteger(target.blockIndex)) return;
    const href = target.chapterHref;
    const item = flatToc.find((entry) => entry.href === href);
    const itemEl = item && [...chapterList.querySelectorAll('.playable-chapter')]
        .find((el) => el.dataset.href === item.href);
    hideResumeBanner();
    if (!item) return;
    // Explicit Resume never autoplays — user presses Play in the overlay.
    activateChapter(item, itemEl || null, false, target.blockIndex);
});

startOverReadingButton?.addEventListener('click', () => {
    void clearCurrentDocumentProgress();
    activateFirstPlayableChapter(false, 0);
});

clearReadingProgressButton?.addEventListener('click', () => {
    void clearCurrentDocumentProgress();
});

function updateActiveChapter(blockIndex) {
    if (!currentChapterBlocks || !currentChapterBlocks[blockIndex]) return;

    const block = currentChapterBlocks[blockIndex];
    if (!block.ids || block.ids.length === 0) return;

    // Fragment IDs are unique within an XHTML file, not across the EPUB.
    // A heading in b.xhtml#title must not activate a.xhtml#title.
    const playbackHref = renderedChapterRequestId === chapterRequestId
        ? renderedChapterHref : currentActiveHref;
    const playbackBase = playbackHref?.split('#')[0];
    // Find if any of these IDs correspond to a TOC item
    // We need to flatten the TOC to search it efficiently or just search recursively
    let bestMatch = null;

    const findMatch = (items) => {
        for (const item of items) {
            // Check if this item's href points to one of our IDs
            // item.href is like "chapter.xhtml#someId" or just "chapter.xhtml"
            const itemHash = item.href.split('#')[1];

            // Use the same decoding as initial chapter selection. Otherwise
            // #caf%C3%A9 can navigate correctly but never update the sidebar
            // when playback reaches <h2 id="café">.
            if (itemHash && item.href.split('#')[0] === playbackBase &&
                block.ids.includes(decodedChapterId(itemHash))) {
                return item;
            }
            // If item has no hash, it points to the start of the file. 
            // We usually don't rely on this for *updates* unless we are at block 0, 
            // but the initial load handles block 0. Here we care about specific anchors.

            if (item.subitems && item.subitems.length > 0) {
                const childMatch = findMatch(item.subitems);
                if (childMatch) return childMatch;
            }
        }
        return null;
    };

    bestMatch = findMatch(currentToc);

    if (bestMatch && bestMatch.href !== currentActiveHref) {
        currentActiveHref = bestMatch.href;

        // 1. Update Sidebar and announce the selected chapter.
        const activeItem = selectActiveChapter(bestMatch.href);
        if (activeItem) {
            activeItem.classList.add('active');
            // Ensure parent groups are expanded
            let parent = activeItem.parentElement;
            while (parent) {
                if (parent.classList.contains('chapter-group')) {
                    setChapterGroupExpanded(parent, true);
                }
                parent = parent.parentElement;
            }
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // 2. Update Overlay Title
        if (playerFrame && playerFrame.contentWindow) {
            playerFrame.contentWindow.postMessage({
                type: 'UPDATE_TITLE',
                title: bestMatch.label
            }, '*');
        }
        updateNavButtons();
    }
}

async function sendToPlayer(content, title, textPreview, startIndex, requestId, requestedBook,
    continuePlaying = false, sourceHref = null, options = {}) {
    const settings = await browser.storage.sync.get([
        'voice', 'normalizationOptions', 'customPronunciations', 'apiUrl',
        'autoplayReader', 'continuousReader', 'ttsBackend', 'mediaPipeVariant',
        'mediaPipeVoice', 'onnxVoiceAsset', 'localVoice',
    ]);
    if (requestId !== chapterRequestId || requestedBook !== book) return;

    // The EPUB reader must follow the same privacy boundary as context-menu TTS:
    // local providers do not carry a server URL into the playback iframe.
    const { backend, apiUrl } = globalThis.KokoroTtsProviders.resolvePlaybackConnection(
        settings.ttsBackend, settings.apiUrl || 'http://127.0.0.1:8880/v1/');

    // In continuous mode, an XHTML file with multiple TOC anchors needs a
    // playback boundary at the next anchor. Other reader modes retain their
    // original complete-section content and progress matching behavior.
    let chapterContent = content;
    if (requestedBook && settings.continuousReader === true) {
        const tocIndex = flatToc.findIndex(item => item.href === currentActiveHref);
        const currentHref = flatToc[tocIndex]?.href;
        const nextHref = flatToc[tocIndex + 1]?.href;
        if (currentHref && nextHref) {
            const [currentBase] = currentHref.split('#');
            const [nextBase, nextFragment] = nextHref.split('#');
            if (currentBase === nextBase && nextFragment) {
                const boundaryId = decodedChapterId(nextFragment);
                const boundary = content.findIndex(b => b.ids?.includes(boundaryId));
                if (boundary > startIndex) chapterContent = content.slice(0, boundary);
            }
        }
    }
    if (requestedBook) currentChapterBlocks = chapterContent;
    const pending = {
        pendingText: textPreview || 'Structured Content',
        pendingContent: chapterContent,
        pendingVoice: settings.voice,
        pendingApiUrl: apiUrl,
        pendingTtsBackend: backend,
        pendingMediaPipeVariant: settings.mediaPipeVariant || 'cpu',
        pendingLocalVoice: globalThis.KokoroLocalVoiceMixing.mediaPipeVoiceFromSettings(settings),
        pendingOnnxVoiceAsset: globalThis.KokoroLocalVoiceMixing.onnxVoiceAssetFromSettings(settings),
        pendingTitle: title || 'Document',
        pendingNormalizationOptions: settings.normalizationOptions,
        pendingCustomPronunciations: settings.customPronunciations,
        pendingStartIndex: startIndex,
        pendingAutoplay: options.suppressAutoplay
            ? false
            : (continuePlaying || settings.autoplayReader === true),
        pendingContinuousReader: Boolean(requestedBook && settings.continuousReader === true),
    };
    // Storage updates can finish out of order even when chapter extraction
    // completed in the desired order. Serialize writes; ignore stale requests
    // both before and after awaiting the operation.
    const operation = playerWriteTail.catch(() => {}).then(async () => {
        await initialPlayerCleanup;
        if (requestId !== chapterRequestId || requestedBook !== book) return;
        // The token travels in the same atomic storage update as the chapter.
        // The iframe acknowledges it after rendering, never merely on postMessage.
        const revision = ++playerReloadRevision;
        await browser.storage.local.set({
            ...pending,
            pendingAutoplay: pending.pendingAutoplay && !readerPausedForPicker,
            pendingReaderReloadRevision: revision,
        });
        if (requestId !== chapterRequestId || requestedBook !== book) return;
        lastPublishedReload = {
            revision, sourceBook: requestedBook, requestId,
            continuousReader: pending.pendingContinuousReader,
            chapterHref: sourceHref,
        };
        playerFrame.contentWindow.postMessage('RELOAD_DATA', '*');
    });
    playerWriteTail = operation.catch(() => {});
    return operation;
}

function continueAfterChapter(revision) {
    if (!book || !renderedChapterContinuous || readerPausedForPicker ||
        revision !== renderedChapterRevision ||
        renderedChapterRequestId !== chapterRequestId ||
        lastContinuedRevision === revision) {
        deferredChapterEndRevision = null;
        return;
    }
    if (filePickerOverlay.style.display !== 'none') {
        deferredChapterEndRevision = revision;
        return;
    }
    deferredChapterEndRevision = null;
    lastContinuedRevision = revision;
    // Visual progress may select a nested TOC heading; continuation follows
    // the file-qualified chapter actually delivered to the player.
    const index = flatToc.findIndex(item => item.href === renderedChapterHref);
    const next = index < 0 ? null : flatToc[index + 1];
    const nextEl = next && [...chapterList.querySelectorAll('.playable-chapter')]
        .find(el => el.dataset.href === next.href);
    if (!nextEl) {
        playerFrame.contentWindow.postMessage({
            type: 'KOKORO_READER_LAST_CHAPTER', revision,
        }, window.location.origin);
        return;
    }
    activateChapter(next, nextEl, true);
}

window.addEventListener('message', (event) => {
    // Accept a successful reload only from our own extension iframe and
    // only for the latest published chapter of the currently selected book.
    // Earlier acknowledgements must not free images still in use by the player.
    if (event.source === playerFrame.contentWindow &&
        event.data?.type === 'KOKORO_READER_RELOAD_READY' &&
        lastPublishedReload?.revision === event.data.revision &&
        lastPublishedReload.sourceBook === book) {
        if (lastPublishedReload.requestId === chapterRequestId) {
            renderedChapterRevision = event.data.revision;
            renderedChapterRequestId = chapterRequestId;
            renderedChapterContinuous = lastPublishedReload.continuousReader;
            renderedChapterHref = lastPublishedReload.chapterHref;
        }
        lastPublishedReload = null;
        releaseRetiredBooks();
    }
    // Only the current EPUB iframe can request continuity; preserve valid
    // completions while a replacement picker is open, then handle them on
    // Cancel. A successful replacement discards the previous completion.
    if (event.source === playerFrame.contentWindow &&
        event.origin === window.location.origin &&
        event.data?.type === 'KOKORO_READER_CHAPTER_ENDED') {
        continueAfterChapter(event.data.revision);
    }
    // Explicit Play after Close/Cancel resumes the existing document and
    // re-enables continuous handoff. Never clear the latch for an unknown
    // frame, a different chapter revision, or while the picker is visible.
    if (event.source === playerFrame.contentWindow &&
        event.origin === window.location.origin &&
        event.data?.type === 'KOKORO_READER_RESUMED' &&
        event.data.revision === renderedChapterRevision &&
        renderedChapterRequestId === chapterRequestId &&
        hasOpenDocument() && filePickerOverlay.style.display === 'none') {
        readerPausedForPicker = false;
        // Play without clicking Resume still counts as committing to the
        // current preview chapter — resume saving from here forward.
        hideResumeBanner();
    }
    // The reader owns its embedded player: Close returns to the document
    // picker without discarding the current book or leaving audio playing.
    // Ignore messages from other frames or unrelated page scripts.
    if (event.source === playerFrame.contentWindow &&
        event.origin === window.location.origin &&
        event.data === 'CLOSE_KOKORO_PLAYER') {
        readerPausedForPicker = true;
        deferredChapterEndRevision = null;
        playerFrame.contentWindow.postMessage('PAUSE_KOKORO_PLAYER', window.location.origin);
        openDocumentPicker();
    }
});

