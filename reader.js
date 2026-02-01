const fileInput = document.getElementById('fileInput');
const filePickerOverlay = document.getElementById('filePickerOverlay');
const chapterList = document.getElementById('chapterList');
const errorMsg = document.getElementById('errorMsg');
const loadingStatus = document.getElementById('loadingStatus');
const playerFrame = document.getElementById('playerFrame');
const sidebar = document.getElementById('sidebar');
const appContainer = document.querySelector('.app-container');

let book = null; // EPUB object


// Clear stale storage on load to prevent ghost audio
browser.storage.local.remove(['pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle']).catch(console.error);

// --- Event Listeners ---

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    errorMsg.style.display = 'none';
    loadingStatus.style.display = 'block';

    try {
        if (file.type === 'application/epub+zip' || file.name.endsWith('.epub')) {
            await loadEpub(file);
        } else {
            throw new Error('Unsupported file type. Please select EPUB.');
        }

        // Check if loading was successful before hiding overlay
        // load functions should throw if valid book info isn't found
        filePickerOverlay.style.display = 'none';

    } catch (err) {
        console.error(err);
        errorMsg.textContent = err.message;
        errorMsg.style.display = 'block';
    } finally {
        loadingStatus.style.display = 'none';
    }
});

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
    reader.onload = (e) => {
        const bookData = e.target.result;
        book = ePub(bookData);

        book.ready.then(() => {
            // Populate Chapters
            const navigation = book.navigation;
            renderChapterList(navigation.toc);
        });
    };
    reader.readAsArrayBuffer(file);
}

function renderChapterList(toc) {
    chapterList.innerHTML = '';

    // Recursive function to flatten or indent?
    // Let's just flatten for simplicity for now, or simple indentation.
    const createItem = (item, level = 0) => {
        const div = document.createElement('div');
        div.className = 'chapter-item';
        div.textContent = item.label.trim() || "Untitled";
        div.style.paddingLeft = `${10 + (level * 15)}px`;
        div.dataset.href = item.href;

        div.addEventListener('click', () => {
            // Update UI
            document.querySelectorAll('.chapter-item').forEach(d => d.classList.remove('active'));
            div.classList.add('active');

            if (book) {
                loadEpubChapter(item.href, item.label);
            }
        });

        chapterList.appendChild(div);

        if (item.subitems && item.subitems.length > 0) {
            item.subitems.forEach(sub => createItem(sub, level + 1));
        }
    };

    toc.forEach(item => createItem(item));

    // Auto-select first item
    const firstItem = chapterList.querySelector('.chapter-item');
    if (firstItem) {
        firstItem.click();
    }
}

async function loadEpubChapter(href, title) {
    // Determine the section from href
    // href might contain #hash
    const section = book.spine.get(href);
    if (section) {
        // Render to extract text? Or use section.load?
        // section.load returns the document.
        const doc = await section.load(book.load.bind(book));

        let contentToProcess = null;
        if (doc) {
            contentToProcess = doc.body || (doc.documentElement ? doc.documentElement : doc);
        }

        if (contentToProcess && typeof contentToProcess.querySelectorAll === 'function') {
            await processAndSendContent(contentToProcess, title || "Chapter");
        } else {
            console.warn("No valid content found for chapter", href, doc);
            // Fallback: search strings?
            if (doc && typeof doc === 'string') {
                // doc itself might be the string content?
                await sendToPlayer([{ type: 'text', content: doc }], "Chapter");
            }
        }
    }
}

// --- Content Processing & sending ---

async function processAndSendContent(bodyElement, title) {
    if (!bodyElement) return;

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
    const rawBlocks = [];
    function walk(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();

            // Skip scripts, styles, etc.
            if (['script', 'style', 'noscript'].includes(tagName)) return;

            if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote'].includes(tagName)) {
                rawBlocks.push({
                    type: (tagName === 'p' || tagName === 'li' || tagName === 'blockquote') ? 'text' : tagName,
                    html: node.innerHTML,
                    content: node.textContent.trim()
                });
            } else if (tagName === 'img') {
                rawBlocks.push({ type: 'image', src: node.src });
            } else if (tagName === 'br') {
                // Ignore BR for block detection, but it might suggest splitting?
                // For now, let it be.
            } else {
                // Container elements (div, section, span, etc.)
                for (const child of node.childNodes) {
                    walk(child);
                }
            }
        } else if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text && node.parentElement === bodyElement) {
                // Loose text in body
                rawBlocks.push({ type: 'text', content: text, html: text });
            }
        }
    }
    walk(bodyElement);

    // 3. Merge broken sentences across blocks (common in OCR or bad EPUB formatting)
    const blocks = [];
    for (const b of rawBlocks) {
        if (b.type === 'text' && blocks.length > 0 && blocks[blocks.length - 1].type === 'text') {
            const last = blocks[blocks.length - 1];
            const lastText = last.content.trim();
            const currText = b.content.trim();

            if (lastText && currText) {
                // Heuristics for continuation:
                // - Last block doesn't end in sentence-ending punctuation.
                // - Current block starts with a lowercase letter.
                const endsInNoPunct = !/[.!?!"”']$/.test(lastText);
                const startsLower = /^[a-z]/.test(currText);

                if (endsInNoPunct || startsLower) {
                    // Merge with a space
                    last.content += ' ' + b.content;
                    // Wrap contents if needed, or just append HTML
                    last.html += ' ' + b.html;
                    continue;
                }
            }
        }
        blocks.push(b);
    }

    const fullText = blocks.map(b => b.content).join(' ');
    await sendToPlayer(blocks, title || "Chapter", fullText.substring(0, 100));
}

async function sendToPlayer(content, title, textPreview) {
    // 1. Save to storage
    const settings = await browser.storage.sync.get(['voice', 'normalizationOptions', 'customPronunciations', 'apiUrl']);
    const apiUrl = settings.apiUrl || 'http://127.0.0.1:8880/v1/';

    await browser.storage.local.set({
        pendingText: textPreview || "Structured Content",
        pendingContent: content,
        pendingVoice: settings.voice,
        pendingApiUrl: apiUrl,
        pendingTitle: title || "Document",
        pendingNormalizationOptions: settings.normalizationOptions,
        pendingCustomPronunciations: settings.customPronunciations
    });

    // 2. Refresh iframe
    // If iframe is already loaded, send message.
    // If not, it will read storage on load.

    // Check if iframe is ready?
    // We can just try sending RELOAD_DATA

    playerFrame.contentWindow.postMessage('RELOAD_DATA', '*');
}


// Listen for messages from iframe?
window.addEventListener('message', (event) => {
    // For example, if overlay wants to close, we might just do nothing or close the tab
    if (event.data === 'CLOSE_KOKORO_PLAYER') {
        // Close tab?
        // window.close();
        console.log("Player requested close - keeping reader open or implement close logic");
    }
});

