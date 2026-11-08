import { processContent } from './text-processor.js';
import { AudioManager } from './audio-manager.js';

const statusEl = document.getElementById('status');
const audioEl = document.getElementById('audio');
const titleEl = document.getElementById('pageTitle');
const textDisplay = document.getElementById('text-display');
const seekBackBtn = document.getElementById('seekBack');
const seekFwdBtn = document.getElementById('seekFwd');
const speedSelect = document.getElementById('speed');
const retryBtn = document.getElementById('retry');
const closeBtn = document.getElementById('close');
const collapseBtn = document.getElementById('collapse');
const dragHandle = document.getElementById('dragHandle');
const spinnerEl = document.getElementById('loadingSpinner');
const saveAudioBtn = document.getElementById('saveAudio');

let sentences = [];
let currentIndex = 0;
let navigationRequestId = 0; // ignores obsolete results even when an index is revisited
let initializationRequestId = 0; // ignores stale asynchronous EPUB reloads
let readerPauseRequested = false; // Close persists across asynchronous reader reloads
let autoScrollChangeRevision = 0; // a late reload must not undo a live toggle
let continuousReaderEnabled = false; // only true for an opted-in EPUB iframe
let activeReaderRevision = null; // which acknowledged chapter is playing
let isPaused = false;
let ignoreNextPause = false;
let overlayCollapsed = false;
let overlayDraggable = true;
let overlayHostSupportsChrome = false;
let activeDragPointerId = null;
let lastDragScreenX = 0;
let lastDragScreenY = 0;

const audioManager = new AudioManager();
const playPauseBtn = document.getElementById('playPause');

function hostPageTargetOrigin() {
    try {
        if (document.referrer) return new URL(document.referrer).origin;
    } catch (e) { }
    try {
        if (location.ancestorOrigins && location.ancestorOrigins.length > 0) {
            return location.ancestorOrigins[0];
        }
    } catch (e) { }
    // Host page origin is unknown for extension iframes on arbitrary sites;
    // fall back only when referrer/ancestorOrigins are unavailable.
    return '*';
}

function postToHostPage(data) {
    window.parent.postMessage(data, hostPageTargetOrigin());
}

function applyOverlayChromeState({ mode, collapsed, draggable } = {}) {
    const isFull = mode === 'full';
    overlayHostSupportsChrome = true;
    overlayCollapsed = !!collapsed;
    overlayDraggable = draggable !== false && !isFull;
    document.body.classList.add('has-host-overlay-state');
    document.body.classList.toggle('collapsed', overlayCollapsed);
    document.body.classList.toggle('mode-full', isFull);
    if (collapseBtn) {
        collapseBtn.setAttribute('aria-label', overlayCollapsed ? 'Expand player' : 'Collapse player');
        collapseBtn.setAttribute('title', overlayCollapsed ? 'Expand' : 'Collapse');
        collapseBtn.textContent = overlayCollapsed ? '+' : '–';
        collapseBtn.setAttribute('aria-expanded', overlayCollapsed ? 'false' : 'true');
    }
    if (dragHandle) {
        dragHandle.style.cursor = overlayDraggable ? 'grab' : 'default';
        dragHandle.setAttribute('aria-disabled', overlayDraggable ? 'false' : 'true');
    }
}

function endOverlayPointerDrag(pointerId) {
    if (activeDragPointerId === null || activeDragPointerId !== pointerId) return;
    if (dragHandle && typeof dragHandle.releasePointerCapture === 'function') {
        try {
            dragHandle.releasePointerCapture(pointerId);
        } catch (e) { /* already released */ }
    }
    activeDragPointerId = null;
    postToHostPage({ action: 'KOKORO_DRAG_END' });
}

// --- Event Listeners ---

// Initialize Compromise plugins
if (window.nlp) {
    if (window.compromiseDates) window.nlp.extend(window.compromiseDates);
    if (window.compromiseNumbers) window.nlp.extend(window.compromiseNumbers);
}

closeBtn.addEventListener('click', () => {
    postToHostPage('CLOSE_KOKORO_PLAYER');
});

if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
        postToHostPage({
            action: 'KOKORO_SET_COLLAPSED',
            collapsed: !overlayCollapsed
        });
    });
}

if (dragHandle) {
    // Keep the full pointer sequence in the iframe (explicit capture) so touch/pen
    // move/up/cancel are not stranded after the host disables iframe hit-testing.
    // Forward screen-space deltas so host geometry stays correct as the iframe moves.
    dragHandle.addEventListener('pointerdown', (event) => {
        if (!overlayHostSupportsChrome || !overlayDraggable) return;
        if (event.button !== undefined && event.button !== 0) return;
        const interactive = event.target.closest(
            'button, a, input, select, textarea, option, label, [role="button"], [role="slider"], [role="link"]'
        );
        if (interactive && interactive !== dragHandle) return;
        event.preventDefault();
        activeDragPointerId = event.pointerId;
        lastDragScreenX = event.screenX;
        lastDragScreenY = event.screenY;
        if (typeof dragHandle.setPointerCapture === 'function') {
            try {
                dragHandle.setPointerCapture(event.pointerId);
            } catch (e) { /* capture unsupported */ }
        }
        postToHostPage({ action: 'KOKORO_DRAG_START' });
    });

    dragHandle.addEventListener('pointermove', (event) => {
        if (activeDragPointerId === null || event.pointerId !== activeDragPointerId) return;
        const dx = event.screenX - lastDragScreenX;
        const dy = event.screenY - lastDragScreenY;
        lastDragScreenX = event.screenX;
        lastDragScreenY = event.screenY;
        if (dx === 0 && dy === 0) return;
        postToHostPage({
            action: 'KOKORO_DRAG_MOVE',
            dx,
            dy
        });
    });

    dragHandle.addEventListener('pointerup', (event) => {
        endOverlayPointerDrag(event.pointerId);
    });

    dragHandle.addEventListener('pointercancel', (event) => {
        endOverlayPointerDrag(event.pointerId);
    });

    dragHandle.addEventListener('lostpointercapture', (event) => {
        if (activeDragPointerId !== null && event.pointerId === activeDragPointerId) {
            activeDragPointerId = null;
            postToHostPage({ action: 'KOKORO_DRAG_END' });
        }
    });
}

// Keep the source audio blob pinned until the browser reports a terminal
// download state. downloads.download() resolves when the download starts, not
// when the browser finishes reading the blob URL.
async function downloadPinnedSentence(url, filename, release) {
    const events = browser.downloads.onChanged;
    if (!events?.addListener || !events?.removeListener) {
        // Older/mocked browser API: release at the only available completion
        // signal. Chrome and Firefox support downloads.onChanged normally.
        try {
            return await browser.downloads.download({ url, filename, saveAs: true });
        } finally {
            release();
        }
    }
    let downloadId = null;
    let finished = false;
    const earlyTerminals = new Set();
    const finish = () => {
        if (finished) return;
        finished = true;
        events.removeListener(onChanged);
        release();
    };
    const onChanged = delta => {
        if (!['complete', 'interrupted'].includes(delta.state?.current)) return;
        if (downloadId === null) earlyTerminals.add(delta.id);
        else if (delta.id === downloadId) finish();
    };
    try {
        events.addListener(onChanged);
        downloadId = await browser.downloads.download({ url, filename, saveAs: true });
        if (earlyTerminals.has(downloadId)) finish();
        return downloadId;
    } catch (error) {
        finish();
        throw error;
    }
}

// Save exactly the current sentence. Local model data never leaves this browser.
if (saveAudioBtn) {
    saveAudioBtn.addEventListener('click', async () => {
        saveAudioBtn.disabled = true;
        let release = null;
        let handedOff = false;
        try {
            const sentenceIndex = currentIndex;
            if (!sentences[sentenceIndex]) throw new Error('No selected sentence');
            release = audioManager.pinAudio(sentenceIndex);
            const audioUrl = await audioManager.getAudio(sentenceIndex);
            if (!audioUrl) throw new Error('No generated audio to save');
            const settings = await browser.storage.local.get(['pendingTtsBackend']);
            const extension = ['mediapipe', 'onnx'].includes(settings.pendingTtsBackend) ? 'wav' : 'mp3';
            const safeTitle = (titleEl.textContent || 'kokoro')
                .replace(/[^a-zA-Z0-9 _-]/g, '_').trim().slice(0, 90) || 'kokoro';
            // The download helper now owns the lease, including error cleanup.
            // Do not release it again in this handler's finally block.
            handedOff = true;
            await downloadPinnedSentence(audioUrl,
                safeTitle + '-sentence-' + (sentenceIndex + 1) + '.' + extension,
                release);
            statusEl.textContent = 'Download started';
        } catch (error) {
            statusEl.textContent = 'Could not save audio: ' + String(error.message || error);
        } finally {
            if (!handedOff) release?.();
            saveAudioBtn.disabled = false;
        }
    });
}

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault(); // Prevent scrolling
        playPauseBtn.click();
    }
});

// Handle messages from parent for navigation / chrome state
window.addEventListener('message', (event) => {
    if (event.data === 'NAV_NEXT') {
        navigate(currentIndex + 1);
    } else if (event.data === 'NAV_PREV') {
        navigate(currentIndex - 1);
    } else if (event.source === window.parent && event.origin === window.location.origin &&
        event.data === 'PAUSE_KOKORO_PLAYER') {
        readerPauseRequested = true;
        // Invalidate an in-flight getAudio so a delayed result cannot start playing.
        navigationRequestId++;
        pause();
    } else if (event.source === window.parent && event.origin === window.location.origin &&
        event.data === 'RESUME_READER_AUTOPLAY') {
        readerPauseRequested = false;
    } else if (event.source === window.parent &&
        event.origin === window.location.origin &&
        event.data?.type === 'KOKORO_READER_LAST_CHAPTER' &&
        event.data.revision === activeReaderRevision) {
        statusEl.textContent = 'Done';
    } else if (event.data === 'RELOAD_DATA') {
        window.hasReceivedData = true;
        initialize();
    } else if (event.data && event.data.action === 'KOKORO_OVERLAY_STATE') {
        applyOverlayChromeState(event.data);
    }
});

playPauseBtn.addEventListener('click', () => {
    if (audioEl.paused) {
        readerPauseRequested = false; // explicit user Play can resume after Close
        if (new URLSearchParams(window.location.search).get('waitForData') === 'true') {
            postToHostPage({
                type: 'KOKORO_READER_RESUMED', revision: activeReaderRevision,
            });
        }
        resume();
    } else {
        pause();
    }
});

seekBackBtn.addEventListener('click', () => {
    navigate(currentIndex - 1);
});

seekFwdBtn.addEventListener('click', () => {
    navigate(currentIndex + 1);
});

speedSelect.addEventListener('change', (e) => {
    audioEl.playbackRate = parseFloat(e.target.value);
});

audioEl.addEventListener('ratechange', () => {
    // Sync dropdown if changed externally
    if (Math.abs(audioEl.playbackRate - parseFloat(speedSelect.value)) > 0.1) {
        speedSelect.value = "1.0"; // Fallback or find closest
    }
});

retryBtn.addEventListener('click', () => {
    initialize();
});

audioEl.addEventListener('ended', () => {
    // A manual skip during the gap must cancel this obsolete automatic step.
    const endedRequestId = navigationRequestId;
    setTimeout(() => {
        if (endedRequestId !== navigationRequestId) return;
        if (continuousReaderEnabled && !readerPauseRequested && !isPaused &&
            currentIndex === sentences.length - 1 &&
            Number.isSafeInteger(activeReaderRevision)) {
            statusEl.textContent = 'Loading next chapter...';
            postToHostPage({
                type: 'KOKORO_READER_CHAPTER_ENDED',
                revision: activeReaderRevision,
            });
        } else {
            navigate(currentIndex + 1);
        }
    }, 50);
});

audioEl.addEventListener('play', () => {
    isPaused = false;
    playPauseBtn.textContent = "Pause";
});

audioEl.addEventListener('pause', () => {
    // Determine if this is a "real" pause or just the gap between sentences?
    // If it ended naturally, we don't want to set isPaused = true, because we want to continue.
    if (audioEl.ended || Math.abs(audioEl.currentTime - audioEl.duration) < 0.1) {
        return;
    }

    if (ignoreNextPause) {
        ignoreNextPause = false;
        return;
    }

    isPaused = true;
    playPauseBtn.textContent = "Play";
});

// --- Logic ---

// Listen for title updates from parent (reader.js)
window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'UPDATE_TITLE') {
        const titleEl = document.getElementById('pageTitle');
        if (titleEl) {
            titleEl.textContent = event.data.title;
        }
    }
});

async function initialize() {
    const loadId = ++initializationRequestId;
    const scrollRevisionAtStart = autoScrollChangeRevision;
    window.focus();
    retryBtn.style.display = 'none';
    statusEl.textContent = "Initializing...";

    // Clear state and invalidate outstanding playback from the previous document.
    navigationRequestId++;
    sentences = [];
    currentIndex = 0;
    continuousReaderEnabled = false;
    activeReaderRevision = null;
    audioManager.clear();
    textDisplay.textContent = '';

    const data = await browser.storage.local.get(['pendingText', 'pendingContent', 'pendingVoice', 'pendingApiUrl', 'pendingTitle', 'defaultSpeed', 'defaultVolume', 'autoScroll', 'pendingCustomPronunciations', 'theme', 'pendingStartIndex', 'pendingAutoplay', 'pendingContinuousReader', 'pendingReaderReloadRevision']);
    // A newer chapter can finish loading while an earlier storage read is
    // still pending. Never paint or start playback from a superseded read.
    if (loadId !== initializationRequestId) return;

    if (autoScrollChangeRevision === scrollRevisionAtStart) {
        window.kokoroAutoScroll = data.autoScroll === true;
    }

    // Check for URL params
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('waitForData') === 'true' && !window.hasReceivedData) {
        statusEl.textContent = "Waiting for document...";
        return;
    }
    // Only the extension's own EPUB reader iframe may request another TOC
    // entry; ordinary webpage overlays never emit chapter-advance messages.
    continuousReaderEnabled = urlParams.get('waitForData') === 'true' &&
        data.pendingContinuousReader === true;
    activeReaderRevision = continuousReaderEnabled &&
        Number.isSafeInteger(data.pendingReaderReloadRevision) &&
        data.pendingReaderReloadRevision > 0
        ? data.pendingReaderReloadRevision : null;

    if (!data.pendingText) {
        statusEl.textContent = "Extracting article...";
        return;
    }

    if (data.theme === 'dark') {
        document.documentElement.classList.add('dark-theme');
        localStorage.setItem('kokoro-theme', 'dark');
    } else {
        document.documentElement.classList.remove('dark-theme');
        localStorage.setItem('kokoro-theme', 'light');
    }

    // Set custom pronunciations for the text processor
    window.kokoroCustomPronunciations = data.pendingCustomPronunciations || {};

    titleEl.textContent = data.pendingTitle || "Kokoro TTS";

    // Set defaults
    if (data.defaultSpeed) {
        audioEl.playbackRate = parseFloat(data.defaultSpeed);
        speedSelect.value = data.defaultSpeed;
    }

    const volumeSlider = document.getElementById('volumeControl');
    if (data.defaultVolume) {
        audioEl.volume = parseFloat(data.defaultVolume);
        if (volumeSlider) volumeSlider.value = data.defaultVolume;
    }

    if (volumeSlider) {
        volumeSlider.addEventListener('input', (e) => {
            audioEl.volume = parseFloat(e.target.value);
        });
    }

    // Pipeline
    // Use structured content if available, fallback to text
    const content = data.pendingContent || [{ type: 'text', content: data.pendingText }];

    // Process Content
    // Need segmenter
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    const result = processContent(content, segmenter);

    sentences = result.sentences;
    window.renderData = result.renderData; // Legacy global or just pass? renderText depends on it.

    audioManager.setSentences(sentences);

    renderText();

    const startSentenceIndex = sentences.findIndex(s => s.blockIndex === (data.pendingStartIndex || 0));
    const initialIndex = startSentenceIndex !== -1 ? startSentenceIndex : 0;

    // Default to true for regular websites (where pendingAutoplay is missing), 
    // but respect the EPUB reader's preference if provided.
    const shouldAutoplay = data.pendingAutoplay !== false && !readerPauseRequested;
    navigate(initialIndex, shouldAutoplay);

    postToHostPage('KOKORO_PLAYER_READY');
    // Reader owns previous-book archive URLs. A RELOAD_DATA post is not a
    // render-completion signal; acknowledge the specific chapter revision
    // only after its content has replaced the previous reader DOM.
    if (urlParams.get('waitForData') === 'true' &&
        Number.isSafeInteger(data.pendingReaderReloadRevision) &&
        data.pendingReaderReloadRevision > 0) {
        postToHostPage({
            type: 'KOKORO_READER_RELOAD_READY',
            revision: data.pendingReaderReloadRevision,
        });
    }
}

function renderText() {
    textDisplay.textContent = '';

    if (!window.renderData) return;

    let currentList = null; // To manage sequential list items

    window.renderData.forEach(block => {
        // If we switch away from list items, or change depth/type, we might break the list chain.
        // Simple logic: If not list item, currentList becomes null.
        if (block.type !== 'list-item') {
            currentList = null;
        }

        if (block.type === 'image') {
            const img = document.createElement('img');
            img.src = block.src;
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
            img.style.display = 'block';
            img.style.margin = '20px auto';
            img.style.borderRadius = '8px';
            img.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
            textDisplay.appendChild(img);
        } else if (block.type === 'caption') {
            const div = document.createElement('div');
            div.textContent = block.text;
            div.className = 'caption';
            div.style.fontSize = '14px';
            div.style.color = 'var(--status-text)';
            div.style.textAlign = 'center';
            div.style.marginBottom = '20px';
            div.style.marginTop = '-10px'; // Pull closer to image
            div.style.padding = '0 10px';
            div.style.fontStyle = 'italic';
            textDisplay.appendChild(div);
        } else if (block.type === 'silent') {
            const div = document.createElement('div');
            div.textContent = block.text;
            div.style.fontSize = '12px';
            div.style.color = 'var(--status-text)';
            div.style.padding = '8px';
            div.style.margin = '15px 0';
            div.style.border = '1px dashed var(--border-color)';
            div.style.borderRadius = '4px';
            div.style.textAlign = 'center';
            div.style.userSelect = 'none'; // Hint it's not content
            textDisplay.appendChild(div);
        } else if (block.type === 'code') {
            const container = document.createElement('div');
            container.style.margin = '20px 0';
            container.style.padding = '1px'; // Outer wrapper padding
            container.style.backgroundColor = '#1e1e1e';
            container.style.borderRadius = '8px';
            container.style.overflow = 'hidden';
            container.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';

            const pre = document.createElement('pre');
            pre.style.margin = '0';
            pre.style.padding = '16px';
            pre.style.overflowX = 'auto';
            pre.style.color = '#d4d4d4';
            pre.style.fontFamily = "'JetBrains Mono', 'Fira Code', 'Menlo', 'Monaco', 'Consolas', monospace";
            pre.style.fontSize = '14px';
            pre.style.lineHeight = '1.5';
            pre.style.tabSize = '4';

            const code = document.createElement('code');
            code.textContent = block.content;
            pre.appendChild(code);
            container.appendChild(pre);
            textDisplay.appendChild(container);
        } else if (block.type === 'html') {
            const div = document.createElement('div');
            const docParser = new DOMParser();
            const tempDoc = docParser.parseFromString(block.html, 'text/html');
            while (tempDoc.body.firstChild) {
                div.appendChild(tempDoc.body.firstChild);
            }
            div.style.margin = '20px 0';
            div.style.overflowX = 'auto'; // Horizontal scroll for wide tables
            div.style.padding = '10px';
            div.style.border = '1px solid var(--border-color)';
            div.style.borderRadius = '8px';

            // Basic table styling injection
            const tables = div.querySelectorAll('table');
            tables.forEach(table => {
                // Ensure table fits container width at least visually
                table.style.minWidth = '100%';
                table.style.borderCollapse = 'collapse';
                table.style.fontFamily = 'sans-serif';
                table.style.fontSize = '0.9em';

                table.querySelectorAll('th, td').forEach(cell => {
                    cell.style.border = '1px solid var(--border-color)';
                    cell.style.padding = '8px 12px';
                });
                table.querySelectorAll('th').forEach(header => {
                    header.style.backgroundColor = 'var(--header-bg)';
                    header.style.fontWeight = 'bold';
                });
            });

            // Figure styling
            const figures = div.querySelectorAll('figure');
            figures.forEach(fig => {
                fig.style.margin = '0';
                fig.style.textAlign = 'center';
                const img = fig.querySelector('img');
                if (img) {
                    img.style.maxWidth = '100%';
                    img.style.height = 'auto';
                    img.style.borderRadius = '4px';
                }
                const caption = fig.querySelector('figcaption');
                if (caption) {
                    caption.style.fontSize = '0.9em';
                    caption.style.color = 'var(--status-text)';
                    caption.style.marginTop = '8px';
                    caption.style.fontStyle = 'italic';
                }
            });

            textDisplay.appendChild(div);
        } else if (block.type === 'paragraph' || block.type === 'list-item' || /^h[1-6]$/.test(block.type)) {
            let container;
            if (block.type === 'list-item') {
                // List logic: Check if we need a new list container (ul/ol)
                if (!currentList || currentList.dataset.listType !== block.listType || parseInt(currentList.dataset.depth) !== block.depth) {
                    currentList = document.createElement(block.listType === 'ol' ? 'ol' : 'ul');
                    currentList.dataset.listType = block.listType || 'ul';
                    currentList.dataset.depth = block.depth || 0;
                    // Indentation based on depth
                    currentList.style.paddingLeft = (20 + (block.depth * 20)) + 'px';
                    currentList.style.margin = '0 0 16px 0'; // Add spacing below the list
                    textDisplay.appendChild(currentList);
                }
                container = document.createElement('li');
                container.style.marginBottom = '8px'; // Spacing between list items
                currentList.appendChild(container);
            } else if (/^h[1-6]$/.test(block.type)) {
                container = document.createElement(block.type);
                container.style.margin = '24px 0 16px 0';
                container.style.fontWeight = '700';
                container.style.lineHeight = '1.3';
                container.style.color = 'var(--text-color)';

                // Scale font size based on level
                const level = parseInt(block.type.substring(1));
                const sizes = ['2em', '1.5em', '1.3em', '1.1em', '1em', '0.9em'];
                container.style.fontSize = sizes[level - 1] || '1em';

                textDisplay.appendChild(container);
            } else {
                // Paragraph logic
                container = document.createElement('p');
                if (block.isQuote) {
                    container.style.borderLeft = '4px solid var(--border-color)';
                    container.style.paddingLeft = '16px';
                    container.style.marginLeft = '20px';
                    container.style.fontStyle = 'italic';
                    container.style.color = 'var(--text-color)';
                    container.style.marginBottom = '16px';
                } else {
                    container.style.margin = '0 0 16px 0'; // Add spacing below paragraph
                }
                textDisplay.appendChild(container);
            }

            block.sentences.forEach(s => {
                const span = document.createElement('span');
                // Use HTML fragment if available, else text
                if (s.html) {
                    // Sanitize again just in case
                    const docParser = new DOMParser();
                    const tempDoc = docParser.parseFromString(window.DOMPurify.sanitize(s.html), 'text/html');
                    while (tempDoc.body.firstChild) {
                        span.appendChild(tempDoc.body.firstChild);
                    }
                } else {
                    span.textContent = s.text;
                }
                // Add spacing
                span.appendChild(document.createTextNode(' '));

                span.className = 'sentence';
                span.dataset.index = s.index;

                span.onclick = (e) => {
                    // If clicked element is a link, let it do its thing and don't navigate player
                    if (e.target.tagName === 'A') {
                        e.stopPropagation();
                        return;
                    }
                    navigate(s.index, true);
                };
                container.appendChild(span);

                // Link element back to sentence object for highlighting/scrolling
                sentences[s.index].element = span;
            });
        }
    });
}

function showBlockedPlayback() {
    isPaused = true;
    playPauseBtn.textContent = "Play";
    statusEl.textContent = "Browser blocked autoplay. Click Play to start.";
}

function pause() {
    isPaused = true;
    audioEl.pause();
    playPauseBtn.textContent = "Play";
}

function resume() {
    isPaused = false;
    const requestId = navigationRequestId;
    audioEl.play().then(() => {
        // A successful user gesture clears the earlier autoplay-blocked text,
        // without changing status from a newer chapter/navigation request.
        if (requestId === navigationRequestId && !isPaused) {
            statusEl.textContent = `Playing sentence ${currentIndex + 1}/${sentences.length}`;
        }
    }).catch(e => {
        if (requestId !== navigationRequestId || isPaused) return;
        if (e.name === 'NotAllowedError') {
            showBlockedPlayback();
            return;
        }
        console.warn("Resume failed", e);
    });
    playPauseBtn.textContent = "Pause";
}

async function navigate(index, forcePlay = null) {
    if (index < 0) index = 0;
    if (index >= sentences.length) {
        statusEl.textContent = "Done";
        return;
    }
    const requestId = ++navigationRequestId;

    // Capture current intention before we pause (which clobbers isPaused)
    const intendedPausedState = forcePlay !== null ? !forcePlay : isPaused;

    // Stop current playback immediately to prevent 'ended' event (and auto-skip)
    // while we are waiting for the new audio to generate.
    if (!audioEl.paused) {
        ignoreNextPause = true;
        audioEl.pause();
    } else {
        // Ensure flag is reset if we were already paused
        ignoreNextPause = false;
    }

    // Restore our intended state (since pause() listener sets isPaused = true)
    isPaused = intendedPausedState;
    playPauseBtn.textContent = isPaused ? "Play" : "Pause";

    // Update highlight
    if (sentences[currentIndex] && sentences[currentIndex].element) {
        sentences[currentIndex].element.classList.remove('highlight');
    }
    currentIndex = index;
    const currentSentence = sentences[currentIndex];
    currentSentence.element.classList.add('highlight');

    // Scroll overlay into view
    currentSentence.element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Scroll origin page if enabled
    // EPUB/other document readers have no matching origin-page DOM.
    // Preserve source spelling and block context across the iframe boundary;
    // normalized TTS text is not necessarily present on the source page.
    if (window.kokoroAutoScroll && currentSentence.sourceText &&
        new URLSearchParams(window.location.search).get('waitForData') !== 'true') {
        postToHostPage({
            action: 'KOKORO_SCROLL_TO_BLOCK',
            text: currentSentence.sourceText,
            blockText: currentSentence.sourceBlockText,
        });
    }

    // Emit progress event for parent (reader.js)
    const blockIndex = sentences[currentIndex].blockIndex;
    if (window.parent) {
        postToHostPage({
            type: 'KOKORO_READING_PROGRESS',
            blockIndex: blockIndex
        });
    }

    // Update Progress
    const progressPercent = ((currentIndex + 1) / sentences.length) * 100;
    const progressBar = document.getElementById('progressBar');
    if (progressBar) progressBar.style.width = `${progressPercent}%`;

    // Estimate Time
    let remainingChars = 0;
    for (let i = currentIndex; i < sentences.length; i++) {
        remainingChars += sentences[i].text.length;
    }
    const speed = parseFloat(speedSelect.value) || 1.0;
    const charsPerSec = 15 * speed;
    const secondsLeft = Math.ceil(remainingChars / charsPerSec);

    const min = Math.floor(secondsLeft / 60);
    const sec = secondsLeft % 60;
    const timeEstimate = document.getElementById('timeEstimate');
    if (timeEstimate) {
        timeEstimate.textContent = `~${min}:${sec.toString().padStart(2, '0')} remaining`;
    }

    statusEl.textContent = `Playing sentence ${currentIndex + 1}/${sentences.length}`;

    try {
        // Suppress obsolete queued prefetch and navigation work *before* the
        // new request enters the local WASM lane. Keep the active audio source
        // until the replacement is ready for retainWindow() to reclaim it.
        audioManager.prioritizeNavigation(currentIndex);
        spinnerEl.style.display = 'block';
        const blobUrl = await audioManager.getAudio(currentIndex);
        if (requestId !== navigationRequestId) return; // Stale result
        spinnerEl.style.display = 'none';

        audioEl.src = blobUrl;
        // Only prune old cached URLs after replacing the active source.
        // Back/forward navigation and the next two prefetched sentences remain.
        audioManager.retainWindow(currentIndex);

        if (!isPaused) {
            audioEl.play().catch(e => {
                // Ignore expected interruptions during rapid navigation
                if (e.name === 'AbortError' || e.message.includes('interrupted')) return;
                if (e.name === 'NotAllowedError') {
                    if (requestId === navigationRequestId && !isPaused) showBlockedPlayback();
                    return;
                }
                console.warn("Play failed", e, e.name);
            });
            playPauseBtn.textContent = "Pause";
        } else {
            playPauseBtn.textContent = "Play";
        }

        audioEl.playbackRate = parseFloat(speedSelect.value); // Re-apply speed

        // Prefetch next
        audioManager.prefetch(currentIndex + 1);
        audioManager.prefetch(currentIndex + 2);

    } catch (e) {
        if (requestId !== navigationRequestId) return; // Do not overwrite newer status.
        spinnerEl.style.display = 'none';
        if (e.name === 'AbortError') return;
        console.error("Playback error", e);
        statusEl.textContent = "Error playing audio.";
    }
}

// Handle theme changes in real-time
browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.autoScroll) {
        autoScrollChangeRevision++;
        window.kokoroAutoScroll = changes.autoScroll.newValue === true;
    }
    if (areaName === 'local' && changes.theme) {
        if (changes.theme.newValue === 'dark') {
            document.documentElement.classList.add('dark-theme');
            localStorage.setItem('kokoro-theme', 'dark');
        } else {
            document.documentElement.classList.remove('dark-theme');
            localStorage.setItem('kokoro-theme', 'light');
        }
    }
});

initialize();
