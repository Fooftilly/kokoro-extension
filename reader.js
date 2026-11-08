import {
    MAX_TEXT_DOCUMENT_BYTES,
    detectDocumentFormat,
    decodeTextDocument,
    parseTextDocument,
} from './document-formats.js';
import { MAX_DOCX_ARCHIVE_BYTES, parseDocxDocument } from './docx-reader.js';

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
let renderedChapterRequestId = null;
let lastContinuedRevision = null; // an ended chapter may advance only once
let readerPausedForPicker = false; // Close must suppress pending chapter autoplay

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
    if (activeFileReader && activeFileReader.readyState === FileReader.LOADING &&
        typeof activeFileReader.abort === 'function') {
        activeFileReader.abort();
    }
    resetPickerState();
    filePickerOverlay.style.display = 'none';
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

// Drag and Drop Handling
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-active'), false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-active'), false);
});

dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const file = dt.files[0];
    if (file) handleFile(file);
});

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
    document.getElementById('showSidebarBtn').style.display = 'block';
});

document.getElementById('showSidebarBtn').addEventListener('click', () => {
    appContainer.classList.remove('sidebar-hidden');
    document.getElementById('showSidebarBtn').style.display = 'none';
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

async function loadEpub(file, requestId) {
    const bookData = await readDocumentBuffer(file);
    if (requestId !== fileRequestId) return;
    if (!(bookData instanceof ArrayBuffer)) {
        throw new Error('EPUB file did not contain binary data');
    }

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

        const publisherToc = candidate.navigation?.toc || [];
        // The EPUB's own navigation is authoritative. Heading scanning is an
        // opt-in alternative, except for books without a publisher TOC.
        const scan = scanDocumentHeadings.checked || publisherToc.length === 0;
        if (scan) loadingStatus.textContent = 'Scanning for chapters...';
        const discovered = scan
            ? await getEnrichedToc(candidate, () => requestId === fileRequestId)
            : publisherToc;
        if (requestId !== fileRequestId) return;
        // Heading-scan links come from Section.href and are already relative
        // to the OPF. Do not resolve them against the nav document again:
        // same-name chapters in different directories would be conflated.
        // If no headings were found, the scanner returns the original
        // publisher array by identity; those raw links still need resolving.
        const toc = scan && discovered !== publisherToc
            ? discovered
            : normalizePublisherToc(discovered, candidate);
        if (!hasPlayableTocEntry(toc)) throw new Error('EPUB contains no readable chapters');

        // Retain the old book until the new chapter reaches the player:
        // current audio/image blob URLs may still refer to its archive.
        const oldBook = book;
        chapterRequestId++;
        book = candidate;
        textDocument = null;
        committed = true;
        if (oldBook) retiringBooks.add(oldBook);
        currentChapterBlocks = [];
        currentActiveHref = null;
        currentToc = toc;
        resumeAutoplayForNewDocument();
        renderChapterList(toc);
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
    const blocks = format === 'docx'
        ? await parseDocxDocument(bytes)
        : parseTextDocument(format, decodeTextDocument(bytes));
    if (requestId !== fileRequestId) return;

    // Preserve the existing EPUB if reading/parsing fails, and hand its image
    // URLs over only after the text chapter has rendered in the iframe.
    const oldBook = book;
    chapterRequestId++;
    book = null;
    textDocument = { blocks, title: file.name };
    if (oldBook) retiringBooks.add(oldBook);
    currentChapterBlocks = blocks;
    currentActiveHref = null;
    currentToc = [{ href: 'document:0', label: file.name }];
    resumeAutoplayForNewDocument();
    renderChapterList(currentToc);
    // Parsing and rendering the chapter list commit the replacement. The
    // async player write must *not* keep Cancel visible after this point.
    // Subsequent storage failures are reported by startTextChapterLoad() in
    // the reader's visible alert, without rolling back a committed document.
}

async function startTextChapterLoad(title) {
    const source = textDocument;
    const requestId = ++chapterRequestId;
    chapterErrorMsg.hidden = true;
    chapterErrorMsg.textContent = '';
    if (!source) return;
    try {
        await sendToPlayer(source.blocks, title || source.title,
            source.blocks.map(entry => entry.content).join(' ').slice(0, 100),
            0, requestId, null);
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

function renderChapterList(toc) {
    chapterList.innerHTML = '';
    flatToc = [];

    const createItem = (item, level = 0) => {
        const playable = Boolean(item.href);
        if (playable) flatToc.push(item);
        const container = document.createElement('div');
        container.className = 'chapter-group';
        if (level > 0) container.classList.add('subchapter-list');

        const itemEl = document.createElement('div');
        itemEl.className = 'chapter-item';
        if (playable) {
            itemEl.classList.add('playable-chapter');
            itemEl.dataset.href = item.href;
        } else {
            itemEl.classList.add('chapter-group-label');
        }
        itemEl.style.paddingLeft = `${10 + (level * 20)}px`;

        const children = item.subitems || item.items || [];
        const hasChildren = children.length > 0;

        if (hasChildren) {
            const toggle = document.createElement('span');
            toggle.className = 'chapter-toggle';
            toggle.textContent = '▶';
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const isExpanded = container.classList.toggle('expanded');
                toggle.textContent = isExpanded ? '▼' : '▶';
            });
            itemEl.appendChild(toggle);
        } else if (level > 0) {
            const spacer = document.createElement('span');
            spacer.className = 'chapter-spacer';
            itemEl.appendChild(spacer);
        }

        const label = document.createElement('span');
        label.className = 'chapter-label';
        label.textContent = (item.label || "Untitled").trim();
        itemEl.appendChild(label);

        if (playable) itemEl.addEventListener('click', () => {
            activateChapter(item, itemEl);
        });

        container.appendChild(itemEl);
        chapterList.appendChild(container);

        if (hasChildren) {
            const subList = document.createElement('div');
            subList.className = 'sub-items';
            children.forEach(sub => {
                const subItem = createItem(sub, level + 1);
                subList.appendChild(subItem);
            });
            container.appendChild(subList);
        }

        return container;
    };

    toc.forEach(item => createItem(item));

    updateNavButtons();

    // Auto-select first item
    const firstItem = chapterList.querySelector('.playable-chapter');
    if (firstItem) {
        firstItem.click();
        // The first actual chapter can be nested below a non-linked <span>
        // grouping label. Expand all its ancestors so it remains visible.
        let group = firstItem.closest('.chapter-group');
        while (group && chapterList.contains(group)) {
            group.classList.add('expanded');
            const toggle = group.firstElementChild?.querySelector('.chapter-toggle');
            if (toggle) toggle.textContent = '▼';
            group = group.parentElement?.closest('.chapter-group');
        }
    }
}

function activateChapter(item, itemEl, continuePlaying = false) {
    document.querySelectorAll('.chapter-item').forEach(el => el.classList.remove('active'));
    itemEl.classList.add('active');
    currentActiveHref = item.href;
    updateNavButtons();
    if (book) {
        startChapterLoad(item.href, item.label, continuePlaying);
    } else if (textDocument) {
        activeTextChapterWrite = startTextChapterLoad(item.label);
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
        const el = [...document.querySelectorAll('.chapter-item')]
            .find(node => node.dataset.href === item.href);
        el?.click();
    }
});
nextChapterBtn.addEventListener('click', () => {
    const index = flatToc.findIndex(item => item.href === currentActiveHref);
    if (index !== -1 && index < flatToc.length - 1) {
        const item = flatToc[index + 1];
        const el = [...document.querySelectorAll('.chapter-item')]
            .find(node => node.dataset.href === item.href);
        el?.click();
    }
});

function updateNavButtons() {
    const currentIndex = flatToc.findIndex(item => item.href === currentActiveHref);
    prevChapterBtn.disabled = currentIndex <= 0;
    nextChapterBtn.disabled = currentIndex === -1 || currentIndex >= flatToc.length - 1;
}

// A prior book may still have section.load() in progress when its successor
// is selected. Track chapter work so Book.destroy() waits for those readers.
function startChapterLoad(href, title, continuePlaying = false) {
    const source = book;
    // The file picker is hidden after successful EPUB loading; chapter errors
    // must be shown in the reader, not in the hidden file picker.
    chapterErrorMsg.hidden = true;
    chapterErrorMsg.textContent = '';
    const task = loadEpubChapter(href, title, continuePlaying);
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

async function loadEpubChapter(href, title, continuePlaying = false) {
    const requestId = ++chapterRequestId;
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

    // baseHref and fragment are already defined at the start of the function
    let startIndex = 0;

    if (fragment) {
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

    const fullText = mergedBlocks.map(b => b.content).join(' ');
    await sendToPlayer(mergedBlocks, title || "Chapter", fullText.substring(0, 100), startIndex,
        requestId, requestedBook, continuePlaying);
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
    if (event.data && event.data.type === 'KOKORO_READING_PROGRESS') {
        updateActiveChapter(event.data.blockIndex);
    }
});

function updateActiveChapter(blockIndex) {
    if (!currentChapterBlocks || !currentChapterBlocks[blockIndex]) return;

    const block = currentChapterBlocks[blockIndex];
    if (!block.ids || block.ids.length === 0) return;

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
            if (itemHash && block.ids.includes(decodedChapterId(itemHash))) {
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

        // 1. Update Sidebar
        document.querySelectorAll('.chapter-item').forEach(d => d.classList.remove('active'));
        const activeItem = [...document.querySelectorAll('.playable-chapter')]
            .find(node => node.dataset.href === bestMatch.href);
        if (activeItem) {
            activeItem.classList.add('active');
            // Ensure parent groups are expanded
            let parent = activeItem.parentElement;
            while (parent) {
                if (parent.classList.contains('chapter-group')) {
                    parent.classList.add('expanded');
                    const toggle = parent.querySelector('.chapter-toggle');
                    if (toggle) toggle.textContent = '▼';
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

async function sendToPlayer(content, title, textPreview, startIndex, requestId, requestedBook, continuePlaying = false) {
    const settings = await browser.storage.sync.get([
        'voice', 'normalizationOptions', 'customPronunciations', 'apiUrl',
        'autoplayReader', 'continuousReader', 'ttsBackend', 'mediaPipeVariant', 'localVoice',
    ]);
    if (requestId !== chapterRequestId || requestedBook !== book) return;

    const apiUrl = settings.apiUrl || 'http://127.0.0.1:8880/v1/';
    const pending = {
        pendingText: textPreview || 'Structured Content',
        pendingContent: content,
        pendingVoice: settings.voice,
        pendingApiUrl: apiUrl,
        pendingTtsBackend: settings.ttsBackend === undefined ? 'fastapi' : settings.ttsBackend,
        pendingMediaPipeVariant: settings.mediaPipeVariant || 'cpu',
        pendingLocalVoice: settings.localVoice || 'af_heart',
        pendingTitle: title || 'Document',
        pendingNormalizationOptions: settings.normalizationOptions,
        pendingCustomPronunciations: settings.customPronunciations,
        pendingStartIndex: startIndex,
        pendingAutoplay: continuePlaying || settings.autoplayReader === true,
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
        lastPublishedReload = { revision, sourceBook: requestedBook, requestId };
        playerFrame.contentWindow.postMessage('RELOAD_DATA', '*');
    });
    playerWriteTail = operation.catch(() => {});
    return operation;
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
        }
        lastPublishedReload = null;
        releaseRetiredBooks();
    }
    // Only the currently acknowledged, still-selected EPUB chapter can ask to
    // continue. Old player completions, duplicate ended events, text documents,
    // and messages received during a pending chapter switch are ignored.
    if (event.source === playerFrame.contentWindow &&
        event.origin === window.location.origin &&
        event.data?.type === 'KOKORO_READER_CHAPTER_ENDED') {
        const revision = event.data.revision;
        if (!book || readerPausedForPicker ||
            filePickerOverlay.style.display !== 'none' ||
            revision !== renderedChapterRevision ||
            renderedChapterRequestId !== chapterRequestId ||
            lastContinuedRevision === revision) return;

        lastContinuedRevision = revision;
        const index = flatToc.findIndex(item => item.href === currentActiveHref);
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
    // The reader owns its embedded player: Close returns to the document
    // picker without discarding the current book or leaving audio playing.
    // Ignore messages from other frames or unrelated page scripts.
    if (event.source === playerFrame.contentWindow &&
        event.origin === window.location.origin &&
        event.data === 'CLOSE_KOKORO_PLAYER') {
        readerPausedForPicker = true;
        playerFrame.contentWindow.postMessage('PAUSE_KOKORO_PLAYER', window.location.origin);
        openDocumentPicker();
    }
});

