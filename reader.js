const fileInput = document.getElementById('fileInput');
const filePickerOverlay = document.getElementById('filePickerOverlay');
const chapterList = document.getElementById('chapterList');
const errorMsg = document.getElementById('errorMsg');
const loadingStatus = document.getElementById('loadingStatus');
const playerFrame = document.getElementById('playerFrame');
const sidebar = document.getElementById('sidebar');
const appContainer = document.querySelector('.app-container');

let book = null; // EPUB object
let currentChapterBlocks = []; // For tracking progress
let currentToc = []; // For resolving chapter titles
let currentActiveHref = null; // To avoid redundant updates


// Clear stale storage on load to prevent ghost audio
browser.storage.local.remove(['pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle']).catch(console.error);

const dropZone = document.getElementById('dropZone');
const fileNameDisplay = document.getElementById('file-name-display');

// --- Event Listeners ---

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
    errorMsg.style.display = 'none';
    loadingStatus.style.display = 'block';

    // Update file name display
    if (fileNameDisplay) {
        fileNameDisplay.textContent = file.name;
    }

    try {
        if (file.type === 'application/epub+zip' || file.name.endsWith('.epub')) {
            await loadEpub(file);
        } else {
            throw new Error('Unsupported file type. Please select EPUB.');
        }

        // Check if loading was successful before hiding overlay
        filePickerOverlay.style.display = 'none';

    } catch (err) {
        console.error(err);
        errorMsg.textContent = err.message;
        errorMsg.style.display = 'block';
    } finally {
        loadingStatus.style.display = 'none';
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

async function loadEpub(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        const bookData = e.target.result;
        book = ePub(bookData);

        try {
            await book.ready;

            loadingStatus.textContent = "Scanning for chapters...";
            loadingStatus.style.display = 'block';

            // Try to enrich TOC with hidden subchapters from spine
            const toc = await getEnrichedToc(book);
            currentToc = toc; // Store globally
            renderChapterList(toc);

            // Check if loading was successful before hiding overlay
            filePickerOverlay.style.display = 'none';

        } catch (err) {
            console.error("EPUB Loading Error:", err);
            errorMsg.textContent = "Failed to load EPUB: " + err.message;
            errorMsg.style.display = 'block';
        } finally {
            loadingStatus.style.display = 'none';
        }
    };
    reader.readAsArrayBuffer(file);
}

/**
 * Scans the spine for sections not in the TOC and attempts to discover subchapters by parsing headings.
 */
async function getEnrichedToc(book) {
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
        const section = spine.get(i);
        const href = section.href;

        try {
            const doc = await section.load(book.load.bind(book));
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
            console.warn("Failed to scan section", href, e);
            if (tocMap.has(href)) {
                const label = tocMap.get(href);
                if (!enriched.some(e => e.label === label)) {
                    currentMain = { label, href, subitems: [] };
                    enriched.push(currentMain);
                }
            }
        }
    }

    return enriched.length > 0 ? enriched : originalToc;
}

function renderChapterList(toc) {
    chapterList.innerHTML = '';

    const createItem = (item, level = 0) => {
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
            if (book) {
                loadEpubChapter(item.href, item.label);
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

async function loadEpubChapter(href, title) {
    const spine = book.spine;
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
    collectHrefs(book.navigation.toc);

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
        const doc = await sec.load(book.load.bind(book));
        const body = doc.body || (doc.documentElement ? doc.documentElement : doc);
        const blocks = await extractBlocks(sec, body);
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
            console.warn("Fragment not found in merged blocks:", fragment);
            const allAvailableIds = mergedBlocks.flatMap(b => b.ids || []);
            console.log("Available IDs in merged blocks:", allAvailableIds);
        }
    }

    const fullText = mergedBlocks.map(b => b.content).join(' ');
    await sendToPlayer(mergedBlocks, title || "Chapter", fullText.substring(0, 100), startIndex);
}

// --- Content Processing & Extraction ---

async function extractBlocks(section, bodyElement) {
    if (!bodyElement) return [];

    // 1. Resolve images
    if (typeof bodyElement.querySelectorAll === 'function') {
        const images = bodyElement.querySelectorAll('img');
        for (const img of images) {
            const src = img.getAttribute('src');
            if (src && book) {
                try {
                    const url = await book.archive.createUrl(src);
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
    }
}

async function sendToPlayer(content, title, textPreview, startIndex = 0) {
    const settings = await browser.storage.sync.get(['voice', 'normalizationOptions', 'customPronunciations', 'apiUrl', 'autoplayReader']);
    const apiUrl = settings.apiUrl || 'http://127.0.0.1:8880/v1/';

    await browser.storage.local.set({
        pendingText: textPreview || "Structured Content",
        pendingContent: content,
        pendingVoice: settings.voice,
        pendingApiUrl: apiUrl,
        pendingTitle: title || "Document",
        pendingNormalizationOptions: settings.normalizationOptions,
        pendingCustomPronunciations: settings.customPronunciations,
        pendingStartIndex: startIndex,
        pendingAutoplay: settings.autoplayReader === undefined ? false : settings.autoplayReader
    });

    playerFrame.contentWindow.postMessage('RELOAD_DATA', '*');
}

window.addEventListener('message', (event) => {
    if (event.data === 'CLOSE_KOKORO_PLAYER') {
        console.log("Player requested close");
    }
});

