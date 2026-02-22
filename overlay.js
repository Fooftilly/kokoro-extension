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
const spinnerEl = document.getElementById('loadingSpinner');

let sentences = [];
let currentIndex = 0;
let isPaused = false;
let ignoreNextPause = false;

const audioManager = new AudioManager();
const playPauseBtn = document.getElementById('playPause');

// --- Event Listeners ---

// Initialize Compromise plugins
if (window.nlp) {
    if (window.compromiseDates) window.nlp.extend(window.compromiseDates);
    if (window.compromiseNumbers) window.nlp.extend(window.compromiseNumbers);
}

closeBtn.addEventListener('click', () => {
    window.parent.postMessage('CLOSE_KOKORO_PLAYER', '*');
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault(); // Prevent scrolling
        playPauseBtn.click();
    }

    if (e.code === 'Escape') {
        window.parent.postMessage('CLOSE_KOKORO_PLAYER', '*');
    }
});

// Handle messages from parent for navigation
window.addEventListener('message', (event) => {
    if (event.data === 'NAV_NEXT') {
        navigate(currentIndex + 1);
    } else if (event.data === 'NAV_PREV') {
        navigate(currentIndex - 1);
    } else if (event.data === 'RELOAD_DATA') {
        window.hasReceivedData = true;
        initialize();
    }
});

playPauseBtn.addEventListener('click', () => {
    if (audioEl.paused) {
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
    // create small gap
    setTimeout(() => {
        navigate(currentIndex + 1);
    }, 50); // 50ms pause between sentences
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
    window.focus();
    retryBtn.style.display = 'none';
    statusEl.textContent = "Initializing...";

    // Clear state
    sentences = [];
    currentIndex = 0;
    audioManager.clear();
    textDisplay.textContent = '';

    const data = await browser.storage.local.get(['pendingText', 'pendingContent', 'pendingVoice', 'pendingApiUrl', 'pendingTitle', 'defaultSpeed', 'defaultVolume', 'autoScroll', 'pendingCustomPronunciations', 'theme', 'pendingStartIndex', 'pendingAutoplay']);

    const autoScroll = data.autoScroll || false;
    window.kokoroAutoScroll = autoScroll;

    // Check for URL params
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('waitForData') === 'true' && !window.hasReceivedData) {
        statusEl.textContent = "Waiting for document...";
        return;
    }

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
    const shouldAutoplay = data.pendingAutoplay !== false;
    navigate(initialIndex, shouldAutoplay);

    window.parent.postMessage('KOKORO_PLAYER_READY', '*');
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

function pause() {
    isPaused = true;
    audioEl.pause();
    playPauseBtn.textContent = "Play";
}

function resume() {
    isPaused = false;
    audioEl.play().catch(e => {
        if (e.name === 'NotAllowedError') {
            isPaused = true;
            playPauseBtn.textContent = "Play";
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
    if (window.kokoroAutoScroll && currentSentence.text) {
        window.parent.postMessage({
            action: 'KOKORO_SCROLL_TO_BLOCK',
            text: currentSentence.text
        }, '*');
    }

    // Emit progress event for parent (reader.js)
    const blockIndex = sentences[currentIndex].blockIndex;
    if (window.parent) {
        window.parent.postMessage({
            type: 'KOKORO_READING_PROGRESS',
            blockIndex: blockIndex
        }, '*');
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
        spinnerEl.style.display = 'block'; // Show spinner
        const blobUrl = await audioManager.getAudio(currentIndex);
        spinnerEl.style.display = 'none'; // Hide spinner
        if (currentIndex !== index) return; // Stale request

        audioEl.src = blobUrl;

        if (!isPaused) {
            audioEl.play().catch(e => {
                // Ignore expected interruptions during rapid navigation
                if (e.name === 'AbortError' || e.message.includes('interrupted')) return;
                if (e.name === 'NotAllowedError') {
                    isPaused = true;
                    playPauseBtn.textContent = "Play";
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
        spinnerEl.style.display = 'none'; // Ensure spinner hidden on error
        console.error("Playback error", e);
        statusEl.textContent = "Error playing audio.";
    }
}

// Handle theme changes in real-time
browser.storage.onChanged.addListener((changes, areaName) => {
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
