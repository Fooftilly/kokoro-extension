import {
    MAX_TEXT_DOCUMENT_BYTES,
    detectDocumentFormat,
    decodeTextDocument,
    parseTextDocument,
} from './document-formats.js';

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
let lastPublishedReload = null; // { revision, sourceBook }; only iframe acknowledgement releases archives

const prevChapterBtn = document.getElementById('prevChapter');
const nextChapterBtn = document.getElementById('nextChapter');


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
        const toc = scan
            ? await getEnrichedToc(candidate, () => requestId === fileRequestId)
            : publisherToc;
        if (requestId !== fileRequestId) return;
        if (!toc.length) throw new Error('EPUB contains no readable chapters');

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
        renderChapterList(toc);
    } finally {
        // A failed/superseded candidate must not retain its ZIP and section
        // documents. Only the successfully committed book remains owned here.
        if (!committed) disposeBook(candidate);
    }
}

// Non-EPUB formats use a single synthetic chapter and the same
// sendToPlayer() storage/iframe path as EPUB. No fake EPUB.js Book is created.
async function loadTextDocument(file, format, requestId) {
    if (Number.isFinite(file.size) && file.size > MAX_TEXT_DOCUMENT_BYTES) {
        throw new Error('Text documents larger than 4 MiB are not supported');
    }
    const bytes = await readDocumentBuffer(file);
    if (requestId !== fileRequestId) return;
    const text = decodeTextDocument(bytes);
    const blocks = parseTextDocument(format, text);
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
        flatToc.push(item);
        const container = document.createElement('div');
        container.className = 'chapter-group';
        if (level > 0) container.classList.add('subchapter-list');

        const itemEl = document.createElement('div');
        itemEl.className = 'chapter-item';
        itemEl.dataset.href = item.href;
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

        itemEl.addEventListener('click', () => {
            document.querySelectorAll('.chapter-item').forEach(d => d.classList.remove('active'));
            itemEl.classList.add('active');
            currentActiveHref = item.href;
            updateNavButtons();
            if (book) {
                startChapterLoad(item.href, item.label);
            } else if (textDocument) {
                activeTextChapterWrite = startTextChapterLoad(item.label);
                // Subsequent manual selections have no awaiting file handler.
                // The reader alert carries errors; avoid unhandled rejections.
                void activeTextChapterWrite.catch(() => {});
            }
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
    const firstItem = chapterList.querySelector('.chapter-item');
    if (firstItem) {
        firstItem.click();
        const firstGroup = firstItem.closest('.chapter-group');
        if (firstGroup && firstGroup.querySelector('.sub-items')) {
            firstGroup.classList.add('expanded');
            const toggle = firstGroup.querySelector('.chapter-toggle');
            if (toggle) toggle.textContent = '▼';
        }
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
function startChapterLoad(href, title) {
    const source = book;
    // The file picker is hidden after successful EPUB loading; chapter errors
    // must be shown in the reader, not in the hidden file picker.
    chapterErrorMsg.hidden = true;
    chapterErrorMsg.textContent = '';
    const task = loadEpubChapter(href, title);
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

async function loadEpubChapter(href, title) {
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
    collectHrefs(requestedBook.navigation.toc);

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
        console.log("Searching for fragment:", fragment);
        const idx = mergedBlocks.findIndex(b => b.ids && b.ids.includes(fragment));
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
        requestId, requestedBook);
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

            // If item has a hash, check if it matches one of the block's IDs
            if (itemHash && block.ids.includes(itemHash)) {
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
        const activeItem = document.querySelector(`.chapter-item[data-href="${bestMatch.href}"]`);
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

async function sendToPlayer(content, title, textPreview, startIndex, requestId, requestedBook) {
    const settings = await browser.storage.sync.get([
        'voice', 'normalizationOptions', 'customPronunciations', 'apiUrl',
        'autoplayReader', 'ttsBackend', 'mediaPipeVariant', 'localVoice',
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
        pendingAutoplay: settings.autoplayReader === undefined ? false : settings.autoplayReader,
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
            ...pending, pendingReaderReloadRevision: revision,
        });
        if (requestId !== chapterRequestId || requestedBook !== book) return;
        lastPublishedReload = { revision, sourceBook: requestedBook };
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
        lastPublishedReload = null;
        releaseRetiredBooks();
    }
    if (event.data === 'CLOSE_KOKORO_PLAYER') {
        console.log("Player requested close");
    }
});

