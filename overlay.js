const statusEl = document.getElementById('status');
const audioEl = document.getElementById('audio');
const titleEl = document.getElementById('pageTitle');
const textDisplay = document.getElementById('text-display');
const seekBackBtn = document.getElementById('seekBack');
const seekFwdBtn = document.getElementById('seekFwd');
const speedSelect = document.getElementById('speed');
const retryBtn = document.getElementById('retry');
const closeBtn = document.getElementById('close');

let sentences = [];
let currentIndex = 0;
let audioCache = new Map(); // index -> Promise<BlobUrl>
let abortController = null;


const playPauseBtn = document.getElementById('playPause');

let isPaused = false;

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
    isPaused = true;
    playPauseBtn.textContent = "Play";
});

// --- Logic ---

async function initialize() {
    retryBtn.style.display = 'none';
    statusEl.textContent = "Initializing...";

    // Clear state
    sentences = [];
    currentIndex = 0;
    audioCache.clear();
    textDisplay.innerHTML = '';
    if (abortController) abortController.abort();
    abortController = new AbortController();

    const data = await browser.storage.local.get(['pendingText', 'pendingContent', 'pendingVoice', 'pendingApiUrl', 'pendingTitle', 'defaultSpeed', 'defaultVolume']);

    if (!data.pendingText) {
        statusEl.textContent = "No text found.";
        return;
    }

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
    processContent(content);
    renderText();
    navigate(0);
}

function processContent(blocks) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    sentences = []; // Reset global sentences array
    window.renderData = []; // Store structure for renderText to use

    let globalIndex = 0;

    blocks.forEach(block => {
        if (block.type === 'image') {
            window.renderData.push(block); // Push block directly, renderText handles it
        } else if (block.type === 'caption' || block.type === 'silent') {
            window.renderData.push(block); // Push block directly
        } else if (block.type === 'text') {
            const html = block.html || block.content;

            // Rich Text Processing via temp DOM
            const tempDiv = document.createElement('div');
            // Sanitize HTML before processing
            // We assume DOMPurify is loaded via overlay.html. If not, this might fail or we should handle it.
            // But removing the fallback silences static analysis warning about "unsafe assignment".
            tempDiv.innerHTML = window.DOMPurify.sanitize(html);

            const plainText = tempDiv.textContent;
            if (!plainText.trim()) return; // Skip empty blocks

            const rawSegments = Array.from(segmenter.segment(plainText));
            const mergedSegments = [];

            // Regex for common abbreviations that shouldn't end a sentence
            const abbrevRegex = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|Vol|Ch|Fig|Ref|Eq)\.$/i;

            for (const seg of rawSegments) {
                const segText = seg.segment;
                // If it's pure whitespace, we usually skip it in the output loop.
                // But for merging purposes, we might need to be careful?
                // If "Dr. " and "Smith" are segments.
                // "Dr. " ends with "Dr. ".
                // If " " is a segment? Segmenter usually keeps whitespace attached or separate depending on granulariry.
                // 'sentence' granularity usually includes trailing spaces in the sentence.
                // So "Dr. " might be the segment.

                if (!segText.trim()) continue;

                // Skip segments that have no alphanumeric characters (e.g. ". . ." or "- - -") to prevent TTS freeze/errors
                if (!/[a-zA-Z0-9]/.test(segText)) continue;

                // Check if we should merge with previous
                if (mergedSegments.length > 0) {
                    const last = mergedSegments[mergedSegments.length - 1];
                    const lastText = last.text;
                    const trimmedLast = lastText.trim();

                    // Merge heuristic conditions:
                    // 1. Known abbreviation (Dr., Mr., etc.)
                    // 2. Ends with a strict dot (no trailing space), implying initials like "G.K." or typos/URLs.
                    // 3. Ends with a single uppercase letter + dot (e.g. "T. Smith", "Robert E. Lee"), implying an initial.

                    const isAbbrev = abbrevRegex.test(trimmedLast);
                    const endsWithStrictDot = lastText.endsWith('.');
                    // Allow dot as separator (e.g. G.K.)
                    const isInitial = /(?:^|[\s\.])[A-Z]\.$/.test(trimmedLast);

                    // Short sentence stitching (< 4 words) to improve flow
                    const lastWordCount = trimmedLast.split(/\s+/).length;
                    const currWordCount = segText.trim().split(/\s+/).length;
                    const isShort = lastWordCount < 4 || currWordCount < 4;

                    // FIX: Don't merge "Short" segments if the previous segment effectively ended a sentence (punctuation).
                    // "Dr." is handled by isAbbrev, so we don't need to worry about dot there.
                    const endsWithPunctuation = /[.!?]['"\u201D\u2019]?\s*$/.test(lastText);
                    const shouldMergeShort = isShort && !endsWithPunctuation;

                    // Handle case where Segmenter splits before the closing quote (e.g. "Run?" -> "Run?" + "” asked")
                    // This catches segments that start with various quotes (including opening quotes if split incorrectly)
                    const startsWithQuote = /^['"\u201D\u2019\u2018\u201C\u02BC]/.test(segText.trim());

                    // Broad merge: if starts with lowercase, it's likely a continuation (attribution "said", "asked", or typo)
                    const startsWithLower = /^[a-z]/.test(segText.trim());

                    // Introductory quote merging (e.g. In "Title?" Rothman writes...)
                    // Checks if last segment starts with a preposition followed by a quote (indicating a title reference) and ends in a quote.
                    // Uses Unicode for “ (\u201C) and ” (\u201D).
                    const endsWithQuote = /['"\u201D\u2019]$/.test(trimmedLast);
                    const introStartRegex = /^(?:In|With|As|From|Under|On|At|By)\s+['"\u201C\u2018]/;
                    const isIntroQuote = introStartRegex.test(trimmedLast) && endsWithQuote;

                    // Unbalanced parentheses check (e.g. "(first cent. BC)")
                    // If the last segment has more '(' than ')', it's likely split mid-parenthesis.
                    const openParens = (lastText.match(/\(/g) || []).length;
                    const closeParens = (lastText.match(/\)/g) || []).length;
                    const isUnbalanced = openParens > closeParens;

                    // Parenthesis/Bracket start (e.g. Citations "(1990)", or "[1]")
                    // Merges if next segment starts with ( or [
                    const startsWithParen = /^[\(\[]/.test(segText.trim());

                    if (isAbbrev || endsWithStrictDot || isInitial || shouldMergeShort || startsWithQuote || startsWithLower || isIntroQuote || isUnbalanced || startsWithParen) {
                        // Merge current segment into previous
                        last.text += segText;
                        continue;
                    }
                }

                mergedSegments.push({
                    text: segText,
                    index: seg.index
                });
            }

            const paraSentences = [];

            for (const seg of mergedSegments) {
                const segText = seg.text;
                // Double check trim logic, we already skipped empty ones, but merging might have affected things?
                // Actually if we merged "Smith" into "Dr. ", segText is "Dr. Smith".

                // Extract HTML fragment for this sentence
                const range = findRange(tempDiv, seg.index, seg.index + segText.length);
                let htmlFragment = segText; // Fallback

                if (range) {
                    const frag = range.cloneContents();
                    const span = document.createElement('span');
                    span.appendChild(frag);
                    htmlFragment = span.innerHTML;
                }

                // Text Normalization for TTS (e.g. 1511-1518 -> 1511 to 1518, 1348-9 -> 1348 to 1349)
                let spokenText = segText;

                // --- Compromise Normalization ---
                if (window.nlp) {
                    try {
                        let doc = nlp(spokenText);

                        // 1. Expand contractions (e.g. "can't" -> "cannot")
                        doc.contractions().expand();

                        // 2. Fractions/Dates:
                        // 'compromise-numbers' fractions().toText() is not standard/reliable for "one eighth" style.
                        // 'compromise-dates' normalize() is not aggressive enough for "Feb." -> "February".
                        // We will rely on our robust Regex replacement map below for these specific TTS cases.

                        spokenText = doc.text();
                    } catch (e) {
                        console.warn("Compromise normalization failed", e);
                    }
                }
                // --------------------------------

                // --- Transliteration (Fallback for non-Latin scripts) ---
                if (window.transliterate) {
                    // Check if text has significant non-latin content?
                    // Actually transliteration library is safe to run on mixed text usually, it keeps ASCII.
                    // But we might want to prioritize it for languages Kokoro doesn't support well directly?
                    // Kokoro supports: English (a), British (b), French (f), Japanese (j), Mandarin (z), Spanish (e), Italian (i), Portuguese (p).
                    // If we encounter Cyrillic, Greek, Hindi, etc., transliterate is useful.
                    // Simple heuristic: always run it? Or run it if non-ascii?
                    // transliterate('Hello') -> 'Hello'.
                    // transliterate('你好') -> 'Ni Hao'.
                    spokenText = window.transliterate(spokenText);
                }
                // --------------------------------

                const dateRangeRegex = /\b((?:c\.|ca\.)?\s*\d{1,4}(?:\s*(?:AD|BC|BCE|CE))?)\s*[-–—]\s*((?:c\.|ca\.)?\s*\d{1,4}(?:\s*(?:AD|BC|BCE|CE))?)\b/gi;

                spokenText = spokenText.replace(dateRangeRegex, (match, p1, p2) => {
                    // Try to handle elided years (e.g. 1348-9 -> 1348 to 1349)
                    const n1 = p1.match(/\d+/);
                    const n2 = p2.match(/\d+/);

                    if (n1 && n2) {
                        const y1 = n1[0];
                        const y2 = n2[0];

                        // If second year is shorter than first (and looks like an elided text), expand it
                        // e.g. 1990-91 (4 vs 2), 1348-9 (4 vs 1)
                        if (y1.length === 4 && y2.length < 4) {
                            const expandedY2 = y1.substring(0, y1.length - y2.length) + y2;
                            const expandedP2 = p2.replace(y2, expandedY2);
                            return `${p1} to ${expandedP2}`;
                        }
                    }
                    return `${p1} to ${p2}`;
                });

                // Normalize Hyphens in alphanumeric strings (e.g. GPT-4 -> GPT 4, 3.5-Turbo -> 3.5 Turbo) to prevent "minus"
                // Replaces hyphen with space if surrounded by alphanumeric chars (or dots for versions).
                // Existing date ranges 1990-1991 are already converted to "to" above, so this won't break them.
                spokenText = spokenText.replace(/([a-zA-Z0-9\.]+)\-([a-zA-Z0-9\.]+)/g, '$1 $2');

                // Normalize Year Pronunciation (e.g. 3100 -> 31 hundred)
                // 1. Handle X000 -> X thousand (e.g. 1000, 2000) - avoiding 10 hundred
                spokenText = spokenText.replace(/\b(\d)000\b/g, '$1 thousand');
                // 2. Handle XX00 -> XX hundred (e.g. 3100, 1500)
                spokenText = spokenText.replace(/\b(\d{2})00\b/g, '$1 hundred');

                // Expand Common Abbreviations
                const abbrevMap = [
                    { regex: /\be\.?g\./gi, replacement: "for example" },
                    { regex: /\bi\.?e\./gi, replacement: "that is" },
                    { regex: /\bcf\./gi, replacement: "compare" },
                    { regex: /\bviz\./gi, replacement: "namely" },
                    { regex: /\bet\s+al\./gi, replacement: "and others" },
                    { regex: /\bibid\./gi, replacement: "ibidem" },
                    { regex: /\bfl\./gi, replacement: "flourished" },
                    { regex: /\bvs\.?/gi, replacement: "versus" },
                    { regex: /\betc\./gi, replacement: "et cetera" },
                    { regex: /\bapprox\./gi, replacement: "approximately" },
                    { regex: /\bvol\./gi, replacement: "Volume" },
                    { regex: /\bch\./gi, replacement: "Chapter" },
                    { regex: /\bfig\./gi, replacement: "Figure" },
                    { regex: /\beq\./gi, replacement: "Equation" },
                    // Academic / Classics additions
                    { regex: /\bc\./g, replacement: "circa" }, // Lowercase strict to avoid 'C.'
                    { regex: /\bca\./gi, replacement: "circa" },
                    { regex: /\bd\./g, replacement: "died" }, // Lowercase strict
                    { regex: /\bed\./g, replacement: "edited by" }, // Lowercase strict to avoid 'Ed.'
                    { regex: /\btrans\./gi, replacement: "translated by" },
                    { regex: /\brec\./gi, replacement: "recensuit" },
                    { regex: /\bsc\./gi, replacement: "namely" },
                    { regex: /\bn\./g, replacement: "note" } // Lowercase strict
                ];

                for (const item of abbrevMap) {
                    spokenText = spokenText.replace(item.regex, item.replacement);
                }

                // Normalize Days (e.g. Sun. -> Sunday)
                const dayMap = {
                    "Sun": "Sunday", "Mon": "Monday", "Tue": "Tuesday", "Tues": "Tuesday",
                    "Wed": "Wednesday", "Thu": "Thursday", "Thurs": "Thursday",
                    "Fri": "Friday", "Sat": "Saturday"
                };
                spokenText = spokenText.replace(/\b(Sun|Mon|Tues?|Wed|Thurs?|Fri|Sat)\./gi, (match, d1) => {
                    const key = d1.charAt(0).toUpperCase() + d1.slice(1).toLowerCase();
                    return dayMap[key] ? dayMap[key] : match;
                });

                // Normalize Months (e.g. Oct. 30 -> October 30, Feb. 2011 -> February 2011, Jan., Feb. -> January, February)
                const monthMap = {
                    "Jan": "January", "Feb": "February", "Mar": "March", "Apr": "April",
                    "Jun": "June", "Jul": "July", "Aug": "August", "Sept": "September", "Sep": "September",
                    "Oct": "October", "Nov": "November", "Dec": "December"
                };
                // Relaxed regex matches Month. anywhere (list or date context)
                spokenText = spokenText.replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\./gi, (match, m1) => {
                    const key = m1.charAt(0).toUpperCase() + m1.slice(1).toLowerCase();
                    return monthMap[key] ? monthMap[key] : match;
                });

                // Robust Fraction Normalization matches "1/8", "1 ⁄ 8" (U+2044), "2/3rds"
                spokenText = spokenText.replace(/\b(\d+)\s*[\/\u2044]\s*(\d+)(?:rds|ths|nds|st)?\b/gi, (match, n, d) => {
                    const num = parseInt(n, 10);
                    const den = parseInt(d, 10);

                    // Safety: Don't normalize if it looks like a large ratio or date (e.g. 9/11, 24/7) unless using U+2044
                    const isFractionSlash = match.includes('\u2044');
                    // Check for spaces around slash implies fraction intent even with standard slash "1 / 4"
                    const hasSpaces = match.includes(' ');

                    if (!isFractionSlash && !hasSpaces) {
                        // Tight slash 1/4. Be conservative.
                        // Allow small denominators 2, 3, 4, 8, 10?
                        const safeDenoms = [2, 3, 4, 5, 8, 10, 100];
                        if (!safeDenoms.includes(den)) return match;
                        // Avoid 24/7 (den=7 not safe), 9/11 (den=11 not safe)
                    }

                    // Ordinal map for denominator
                    let ordinal = d + "th"; // default for TTS (e.g. "6th")
                    if (den === 1) ordinal = "whole";
                    else if (den === 2) ordinal = "half";
                    else if (den === 3) ordinal = "third";
                    else if (den === 4) ordinal = "quarter";
                    else if (den === 5) ordinal = "fifth";
                    else if (den === 8) ordinal = "eighth";
                    else if (den === 9) ordinal = "ninth";
                    else if (den === 12) ordinal = "twelfth";

                    // Pluralize
                    if (num !== 1) {
                        if (ordinal === "half") ordinal = "halves";
                        else ordinal += "s";
                    }

                    return `${n} ${ordinal}`;
                });

                // Regnal/Ordinal Roman Numerals (Names like Henry VIII -> Henry the Eighth)
                // Must run BEFORE the general cardinal replacement.
                const ordinalRomanMap = {
                    "II": "second", "III": "third", "IV": "fourth", "VI": "sixth", "VII": "seventh", "VIII": "eighth", "IX": "ninth",
                    "XI": "eleventh", "XII": "twelfth", "XIII": "thirteenth", "XIV": "fourteenth", "XV": "fifteenth",
                    "XVI": "sixteenth", "XVII": "seventeenth", "XVIII": "eighteenth", "XIX": "nineteenth", "XX": "twentieth",
                    "XXI": "twenty-first", "XXII": "twenty-second", "XXIII": "twenty-third"
                };
                // Exclude list: Words that precede numerals but use Cardinal (Chapter Two, not Chapter the Second)
                const nonRegnalTriggers = new Set([
                    "Chapter", "Vol", "Volume", "Part", "Bk", "Book", "Level", "Stage", "Grade", "Phase",
                    "Section", "Class", "Type", "Model", "Mark", "Case", "Plate", "Fig", "Figure",
                    "No", "Number", "World", "War", "Apollo", "Saturn" // World War II, Apollo XI
                ]);

                // Match Capitalized Name + Space + Roman Numeral (II-XXIII)
                spokenText = spokenText.replace(/\b([A-Z][a-z]+)\s+(II|III|IV|VI|VII|VIII|IX|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX|XXI|XXII|XXIII)\b/g, (match, name, rom) => {
                    if (nonRegnalTriggers.has(name)) return match; // Leave for general handler (Chapter II -> Chapter Two)
                    return ordinalRomanMap[rom] ? `${name} the ${ordinalRomanMap[rom]}` : match;
                });

                // Normalize Roman Numerals (II -> two, VII -> seven)
                // Restrict to common UPPERCASE Roman numerals forming 2-30, excluding single letters I, V, X for safety (I=pronoun, V/X=variables).
                const romanMap = {
                    "II": "two", "III": "three", "IV": "four", "VI": "six", "VII": "seven", "VIII": "eight", "IX": "nine",
                    "XI": "eleven", "XII": "twelve", "XIII": "thirteen", "XIV": "fourteen", "XV": "fifteen",
                    "XVI": "sixteen", "XVII": "seventeen", "XVIII": "eighteen", "XIX": "nineteen", "XX": "twenty",
                    "XXI": "twenty-one", "XXII": "twenty-two", "XXIII": "twenty-three", "XXIV": "twenty-four", "XXV": "twenty-five",
                    "XXVI": "twenty-six", "XXVII": "twenty-seven", "XXVIII": "twenty-eight", "XXIX": "twenty-nine", "XXX": "thirty"
                };
                // Updated matches to support extensions like "IIIa" -> "three a"
                spokenText = spokenText.replace(/\b(II|III|IV|VI|VII|VIII|IX|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX|XXI|XXII|XXIII|XXIV|XXV|XXVI|XXVII|XXVIII|XXIX|XXX)([a-e])?\b/g, (match, rom, suffix) => {
                    const num = romanMap[rom];
                    if (!num) return match;
                    return suffix ? `${num} ${suffix}` : num;
                });

                // Normalize Measurements (6″ -> 6 inches, 6′ -> 6 feet, 15 cm -> 15 centimeters)
                // U+2033 (Double Prime) -> inches
                spokenText = spokenText.replace(/\b(\d+)\s*″/g, '$1 inches');
                // U+2032 (Prime) -> feet
                spokenText = spokenText.replace(/\b(\d+)\s*′/g, '$1 feet');
                // Inches (in) - context aware (not followed by another number e.g. "2 in 5")
                spokenText = spokenText.replace(/\b(\d+)\s*in\b(?!\s+\d)/gi, '$1 inches');

                // Common Units
                const unitMap = {
                    "cm": "centimeters", "mm": "millimeters", "km": "kilometers",
                    "kg": "kilograms", "lb": "pounds", "oz": "ounces",
                    "mj": "megajoules", "kj": "kilojoules", // extra safety?
                    "m": "meters", "g": "grams"
                };
                spokenText = spokenText.replace(/\b(\d+)\s*(cm|mm|km|kg|lb|oz|mj|kj|m|g)\b/gi, (match, num, unit) => {
                    const key = unit.toLowerCase();
                    const fullUnit = unitMap[key] || unit;
                    let outUnit = fullUnit;
                    // Handle singular (1 meter vs 2 meters)
                    if (parseInt(num) === 1 && outUnit.endsWith('s')) {
                        outUnit = outUnit.slice(0, -1);
                    }
                    return `${num} ${outUnit}`;
                });

                const sentenceObj = {
                    index: globalIndex++,
                    text: spokenText.trim(), // Clean text for TTS
                    html: htmlFragment    // Rich HTML for display
                };
                sentences.push(sentenceObj);
                paraSentences.push(sentenceObj);
            }

            if (paraSentences.length > 0) {
                window.renderData.push({ type: 'paragraph', sentences: paraSentences });
            }
        }
    });
}

// Helper function to find a DOM Range for given character indices within a root element's textContent
function findRange(root, start, end) {
    let charCount = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;

    function walk(node) {
        if (startNode && endNode) return; // Stop early if both found

        if (node.nodeType === 3) { // Text node
            const len = node.length;
            const absoluteStart = charCount;
            const absoluteEnd = charCount + len;

            // Check if 'start' falls within this text node
            if (!startNode && start >= absoluteStart && start < absoluteEnd) {
                startNode = node;
                startOffset = start - absoluteStart;
            }
            // Check if 'end' falls within this text node
            // 'end' can be exactly 'absoluteEnd' (e.g., end of the node)
            if (!endNode && end > absoluteStart && end <= absoluteEnd) {
                endNode = node;
                endOffset = end - absoluteStart;
            }

            charCount += len;
        } else {
            // Traverse children for non-text nodes
            for (const child of node.childNodes) {
                walk(child);
                if (startNode && endNode) return; // Stop early if both found during child traversal
            }
        }
    }

    walk(root);

    if (startNode && endNode) {
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        return range;
    }
    // Return null if the range could not be fully determined (e.g., indices out of bounds)
    return null;
}

function renderText() {
    textDisplay.innerHTML = '';

    if (!window.renderData) return;

    window.renderData.forEach(block => {
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
            div.style.color = '#777';
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
            div.style.color = '#aaa';
            div.style.padding = '8px';
            div.style.margin = '15px 0';
            div.style.border = '1px dashed #eee';
            div.style.borderRadius = '4px';
            div.style.textAlign = 'center';
            div.style.userSelect = 'none'; // Hint it's not content
            textDisplay.appendChild(div);
        } else if (block.type === 'paragraph') {
            const p = document.createElement('p');
            p.style.margin = '0 0 16px 0'; // Add spacing

            block.sentences.forEach(s => {
                const span = document.createElement('span');
                // Use HTML fragment if available, else text
                if (s.html) {
                    // Sanitize again just in case
                    span.innerHTML = window.DOMPurify.sanitize(s.html);
                } else {
                    span.textContent = s.text;
                }
                // Add spacing
                span.appendChild(document.createTextNode(' '));

                span.className = 'sentence';
                span.dataset.index = s.index;
                // Preserve link clicks inside the sentence from bubbling to navigate?
                // Actually navigate on click is good, but if user clicks a link <a> inside, we might want to follow link?
                // Links have target=_blank.
                // We should stop propagation on link clicks so we don't trigger navigate+play if user just wanted to open link.

                span.onclick = (e) => {
                    // If clicked element is a link, let it do its thing and don't navigate player
                    if (e.target.tagName === 'A') {
                        e.stopPropagation();
                        return;
                    }
                    navigate(s.index);
                    resume(); // Force play on click
                };
                p.appendChild(span);

                // Link element back to sentence object for highlighting/scrolling
                sentences[s.index].element = span;
            });

            textDisplay.appendChild(p);
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
    audioEl.play().catch(e => console.warn("Resume failed", e));
    playPauseBtn.textContent = "Pause";
}

async function navigate(index) {
    if (index < 0) index = 0;
    if (index >= sentences.length) {
        statusEl.textContent = "Done";
        return;
    }

    // Don't auto-reset isPaused if we are just moving index programmatically
    // But usually navigate() implies we want to hear it.
    // If navigate is called by 'ended', we want to continue.
    // If called by click, we want to play.

    // Update highlight
    if (sentences[currentIndex] && sentences[currentIndex].element) {
        sentences[currentIndex].element.classList.remove('highlight');
    }
    currentIndex = index;
    const currentSentence = sentences[currentIndex];
    currentSentence.element.classList.add('highlight');

    // Scroll into view logic
    currentSentence.element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Update Progress
    const progressPercent = ((currentIndex + 1) / sentences.length) * 100;
    const progressBar = document.getElementById('progressBar');
    if (progressBar) progressBar.style.width = `${progressPercent}%`;

    // Estimate Time
    // Simple heuristic: 150 words per minute roughly? Or just use characters.
    // Average speaking rate: ~15 chars / sec.
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
        const blobUrl = await getAudio(currentIndex);
        if (currentIndex !== index) return; // Stale request

        audioEl.src = blobUrl;

        // Respect paused state if this was an auto-advance?
        // Actually, if we are auto-advancing, it means we are NOT paused.
        // If we are navigating via click, we likely want to play.
        // So generally, navigate() implies -> Play.

        if (!isPaused) {
            audioEl.play().catch(e => {
                // Ignore expected interruptions during rapid navigation
                if (e.name === 'AbortError' || e.message.includes('interrupted')) return;
                console.warn("Play failed", e);
            });
            playPauseBtn.textContent = "Pause";
        } else {
            playPauseBtn.textContent = "Play";
        }

        audioEl.playbackRate = parseFloat(speedSelect.value); // Re-apply speed

        // Prefetch next
        prefetch(currentIndex + 1);
        prefetch(currentIndex + 2);

    } catch (e) {
        console.error("Playback error", e);
        statusEl.textContent = "Error playing audio.";
    }
}

async function getAudio(index) {
    if (index >= sentences.length) return null;

    if (audioCache.has(index)) {
        return audioCache.get(index);
    }

    const promise = fetchAudio(sentences[index].text);
    audioCache.set(index, promise);
    return promise;
}

function prefetch(index) {
    if (index < sentences.length && !audioCache.has(index)) {
        getAudio(index);
    }
}

async function fetchAudio(text) {
    const data = await browser.storage.local.get(['pendingVoice', 'pendingApiUrl']);
    const endpoint = new URL('audio/speech', data.pendingApiUrl).href;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'kokoro',
                input: text,
                voice: data.pendingVoice,
                response_format: 'mp3',
                speed: 1.0 // Generate at 1x, client handles speed
            }),
            signal: abortController.signal
        });

        if (!response.ok) throw new Error("API Error");

        const blob = await response.blob();
        return URL.createObjectURL(blob);
    } catch (e) {
        if (e.name === 'AbortError') throw e;

        let msg = e.message;
        if (msg === "Failed to fetch") {
            msg = "Connection failed. Is Kokoro-FastAPI running on 127.0.0.1:8880?";
        }
        console.error("Kokoro Fetch failed:", e);
        statusEl.textContent = "Error: " + msg;
        // Remove from cache so we can retry
        // But since we return a promise, we need to handle rejection
        throw e;
    }
}

initialize();
