import { findRange } from './dom-utils.js';

export function processContent(blocks, segmenter) {
    const sentences = [];
    const renderData = [];
    let globalIndex = 0;

    blocks.forEach(block => {
        if (block.type === 'image') {
            renderData.push(block);
        } else if (block.type === 'caption' || block.type === 'silent' || block.type === 'code') {
            renderData.push(block);
        } else if (block.type === 'html') {
            const safeHtml = window.DOMPurify.sanitize(block.html, {
                // Allow some table/figure tags and attributes if they were stripped by default settings
                ADD_TAGS: ['table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'figure', 'figcaption'],
                ADD_ATTR: ['src', 'alt', 'colspan', 'rowspan']
            });
            renderData.push({ type: 'html', html: safeHtml, content: block.content });
        } else if (block.type === 'text' || block.type === 'list-item' || /^h[1-6]$/.test(block.type)) {
            const html = block.html || block.content;

            const docParser = new DOMParser();
            const tempDoc = docParser.parseFromString(window.DOMPurify.sanitize(html), 'text/html');
            const tempDiv = tempDoc.body;

            const plainText = tempDiv.textContent;
            if (!plainText.trim()) return;

            const rawSegments = Array.from(segmenter.segment(plainText));
            const mergedSegments = [];

            const abbrevRegex = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|Vol|Ch|Fig|Ref|Eq|No|pp|p|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/i;

            for (const seg of rawSegments) {
                const segText = seg.segment;
                if (!segText.trim()) continue;
                if (!/[a-zA-Z0-9]/.test(segText)) continue;

                if (mergedSegments.length > 0) {
                    const last = mergedSegments[mergedSegments.length - 1];
                    const lastText = last.text;
                    const trimmedLast = lastText.trim();

                    const isAbbrev = abbrevRegex.test(trimmedLast);
                    const endsWithStrictDot = lastText.endsWith('.');
                    const isInitial = /(?:^|[\s\.])[A-Z]\.$/.test(trimmedLast);

                    const lastWordCount = trimmedLast.split(/\s+/).length;
                    const currWordCount = segText.trim().split(/\s+/).length;
                    const isShort = lastWordCount < 4 || currWordCount < 4;

                    const endsWithPunctuation = /[.!?]['"\u201D\u2019]?\s*$/.test(lastText);
                    const shouldMergeShort = isShort && !endsWithPunctuation;

                    const startsWithQuote = /^['"\u201D\u2019\u2018\u201C\u02BC]/.test(segText.trim());
                    const startsWithLower = /^[a-z]/.test(segText.trim());

                    const endsWithQuote = /['"\u201D\u2019]$/.test(trimmedLast);
                    const introStartRegex = /^(?:In|With|As|From|Under|On|At|By)\s+['"\u201C\u2018]/;
                    const isIntroQuote = introStartRegex.test(trimmedLast) && endsWithQuote;

                    const openParens = (lastText.match(/\(/g) || []).length;
                    const closeParens = (lastText.match(/\)/g) || []).length;
                    const isUnbalanced = openParens > closeParens;

                    const startsWithParen = /^[\(\[]/.test(segText.trim());

                    if (isAbbrev || endsWithStrictDot || isInitial || shouldMergeShort || startsWithQuote || startsWithLower || isIntroQuote || isUnbalanced || startsWithParen) {
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
                const range = findRange(tempDiv, seg.index, seg.index + segText.length);
                let htmlFragment = segText;

                if (range) {
                    const frag = range.cloneContents();
                    const span = document.createElement('span');
                    span.appendChild(frag);
                    htmlFragment = span.innerHTML;
                }

                let spokenText = segText;

                // --- Compromise Normalization ---
                if (window.nlp) {
                    try {
                        let doc = window.nlp(spokenText);
                        doc.contractions().expand();
                        spokenText = doc.text();
                    } catch (e) {
                        console.warn("Compromise normalization failed", e);
                    }
                }

                // --- Specialized Normalization ---

                // -1. Remove Footnote Artifacts
                spokenText = spokenText.replace(/#[\w-]{2,}/g, '');
                // Remove hidden/invisible characters that often break regexes (BOM, ZWS, etc.)
                spokenText = spokenText.replace(/[\ufeff\u200b\u200c\u200d\u200e\u200f]/g, '');

                // 0. Fix Symbols
                // Em-dash to comma for pause
                spokenText = spokenText.replace(/—/g, ', ');

                spokenText = spokenText.replace(/>\s*(\d)/g, 'greater than $1');
                spokenText = spokenText.replace(/<\s*(\d)/g, 'less than $1');

                // Temperature: Handle °C, deg C, degrees C, and Fahrenheit variants
                spokenText = spokenText.replace(/(\d)\s*(?:°|deg|degrees)\.?\s*C\b/gi, '$1 degrees Celsius');
                spokenText = spokenText.replace(/(\d)\s*(?:°|deg|degrees)\.?\s*F\b/gi, '$1 degrees Fahrenheit');

                // Handle negative numbers: hyphen or unicode minus
                spokenText = spokenText.replace(/(?:-|−)(\d+)\s*degrees (Celsius|Fahrenheit)/g, 'minus $1 degrees $2');

                // General math symbols (if they look like math context, e.g. surrounded by variables or numbers)
                // Equals sign
                spokenText = spokenText.replace(/(\s+=\s+)/g, ' equals ');
                // Plus sign in math
                spokenText = spokenText.replace(/(\w|\d)\s*\+\s*(\w|\d)/g, '$1 plus $2');
                // General minus sign (unicode)
                spokenText = spokenText.replace(/(\w|\d)\s*−\s*(\w|\d)/g, '$1 minus $2');

                // Chemical formulas
                spokenText = spokenText.replace(/\bCO2\b/g, 'carbon dioxide');

                // Dimensions: 20x20, 20 x 20, 20 cm x 8 cm
                spokenText = spokenText.replace(/\b(\d+(?:\.\d+)?)\s*([a-zA-Zµ°]+)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*([a-zA-Zµ°]+)?\b/gi, (match, n1, u1, n2, u2) => {
                    // Avoid formatting hex numbers like 0x10
                    if (/^0x[0-9a-f]+/i.test(match)) return match;

                    let s = `${n1}`;
                    if (u1) s += ` ${u1}`;
                    s += ' by ';
                    s += `${n2}`;
                    if (u2) s += ` ${u2}`;
                    return s;
                });

                // Math spacing: handle 3xy, xy etc in math-like context (simple heuristic)
                // If we see a sequence of letter-letter or digit-letter that isn't a known unit
                spokenText = spokenText.replace(/\b(\d+)([a-z]{1,2})\b/gi, (match, n, v) => {
                    // Avoid units like 10cm, 5m, 10in, 10ft, 10s, 5h
                    const units = new Set(['cm', 'mm', 'km', 'kg', 'lb', 'oz', 'mj', 'kj', 'm', 'g', 'in', 'ft', 's', 'h', 'ms', 'μm']);
                    const lowerV = v.toLowerCase();
                    if (units.has(lowerV)) return match;
                    // Protect decades like 1940s, 80s
                    if (lowerV === 's' && (n.length === 4 || n.length === 2)) return match;

                    return `${n} ${v.split('').join(' ')}`;
                });

                // (Model names rule moved after power rule)

                // Power: squared and cubed (x2, y3, or with unicode)
                // (Moved after specialized units like m3, m2)

                // 1. Fix AD/BC Spacing
                spokenText = spokenText.replace(/\b(\d+)(AD|BC|BCE|CE)\b/gi, '$1 $2');

                // 1.1 Fix Decades (1940s -> nineteenfory-s)
                const decadeMap = {
                    "20": "twenties", "30": "thirties", "40": "forties", "50": "fifties",
                    "60": "sixties", "70": "seventies", "80": "eighties", "90": "nineties",
                    "00": "hundreds"
                };

                // Handle 2-digit decades optionally preceded by an apostrophe
                spokenText = spokenText.replace(/\b(?:'|’|‘|02BC)?(\d0)\s*s\b/g, (match, d) => {
                    return decadeMap[d] ? decadeMap[d] : match;
                });

                // Handle 4-digit decades
                spokenText = spokenText.replace(/\b(\d{2})(\d0)\s*s\b/g, (match, prefix, d) => {
                    const period = decadeMap[d];
                    if (!period) return match;
                    return `${prefix} ${period}`;
                });

                // 2. Fix Ratios
                spokenText = spokenText.replace(/\b(\d+):(\d)\b/g, '$1 to $2');

                // 3. Fix Cubic Meters
                spokenText = spokenText.replace(/kg\/m[3³]/gi, 'kilograms per cubic meter');
                spokenText = spokenText.replace(/\bm³/g, 'cubic meters');
                spokenText = spokenText.replace(/\b(\d+)\s*m3\b/gi, '$1 cubic meters');
                spokenText = spokenText.replace(/\bcfm\b/gi, 'cubic feet per minute');

                // 4. Fix Square Meters and Power
                spokenText = spokenText.replace(/MW\/m[2²]/g, 'megawatts per square meter');
                spokenText = spokenText.replace(/mW\/m[2²]/g, 'milliwatts per square meter');
                spokenText = spokenText.replace(/W\/m[2²]/g, 'watts per square meter');
                spokenText = spokenText.replace(/kg\/m[2²]/g, 'kilograms per square meter');
                spokenText = spokenText.replace(/\bm²/g, 'square meters');
                spokenText = spokenText.replace(/\b(\d+)\s*m2\b/gi, '$1 square meters');

                // 5. Velocity
                spokenText = spokenText.replace(/m\/s\b/g, 'meters per second');

                // Math Power (Refined): handle x2, y3 etc AFTER specialized units
                spokenText = spokenText.replace(/\b([xyzabc])2\b/gi, '$1 squared');
                spokenText = spokenText.replace(/\b([xyzabc])3\b/gi, '$1 cubed');
                spokenText = spokenText.replace(/([xyzabc])\s*²\b/gi, '$1 squared');
                spokenText = spokenText.replace(/([xyzabc])\s*³\b/gi, '$1 cubed');

                // Model names / Variables: handle o1, r1 etc
                spokenText = spokenText.replace(/\b([a-z])(\d+)\b/gi, '$1 $2');

                // Date normalization: 2023-12-25 -> the 25th of December, 2023
                // Must be BEFORE date range expansion (which catches 2023-12)
                spokenText = spokenText.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/gi, (match, year, month, day) => {
                    const m = parseInt(month, 10);
                    const d = parseInt(day, 10);
                    if (m < 1 || m > 12) return match;

                    const months = [
                        "January", "February", "March", "April", "May", "June",
                        "July", "August", "September", "October", "November", "December"
                    ];
                    const fullMonth = months[m - 1];

                    let ordinal = d.toString();
                    if (d === 1 || d === 21 || d === 31) ordinal += "st";
                    else if (d === 2 || d === 22) ordinal += "nd";
                    else if (d === 3 || d === 23) ordinal += "rd";
                    else ordinal += "th";

                    return `the ${ordinal} of ${fullMonth}, ${year}`;
                });

                const dateRangeRegex = /\b((?:c\.|ca\.)?\s*\d{1,4}(?:\s*(?:AD|BC|BCE|CE))?)\s*[-–—]\s*((?:c\.|ca\.)?\s*\d{1,4}(?:\s*(?:AD|BC|BCE|CE))?)\b/gi;

                spokenText = spokenText.replace(dateRangeRegex, (match, p1, p2) => {
                    const n1 = p1.match(/\d+/);
                    const n2 = p2.match(/\d+/);
                    if (n1 && n2) {
                        const y1 = n1[0];
                        const y2 = n2[0];
                        if (y1.length === 4 && y2.length < 4) {
                            const expandedY2 = y1.substring(0, y1.length - y2.length) + y2;
                            const expandedP2 = p2.replace(y2, expandedY2);
                            return `${p1} to ${expandedP2}`;
                        }
                    }
                    return `${p1} to ${p2}`;
                });

                // Acronyms with plural or possessive 's' (LMs, LLMs, MIT’s)
                // We target 2+ uppercase letters followed by 's or s at the end of a word or followed by non-alpha
                // We use a more restrictive regex to avoid matching short words like "As", "Is", "In" if they were somehow uppercase
                spokenText = spokenText.replace(/\b([A-Z]{2,})(['\u2019\u02BC]s|s)\b/g, (match, acronym, suffix) => {
                    // Skip if it's all uppercase and 2 letters, maybe too risky? e.g. "US", "UK"
                    // But plural acronyms are usually 2+ letters anyway.
                    const spaced = acronym.split('').join(' ');
                    const cleanSuffix = suffix.replace(/['\u2019\u02BC]/, "'");
                    return `${spaced} ${cleanSuffix}`;
                });

                const monthMap = {
                    "Jan": "January", "Feb": "February", "Mar": "March", "Apr": "April",
                    "Jun": "June", "Jul": "July", "Aug": "August", "Sept": "September", "Sep": "September",
                    "Oct": "October", "Nov": "November", "Dec": "December",
                    "January": "January", "February": "February", "March": "March", "April": "April", "May": "May",
                    "June": "June", "July": "July", "August": "August", "September": "September",
                    "October": "October", "November": "November", "December": "December"
                };

                // Date normalization: 22 June 1915 or 22 Jan 1915
                const fullMonthNames = Object.keys(monthMap).sort((a, b) => b.length - a.length).join('|');

                // Date normalization: December 25, 2023 or Dec 25, 2023 -> the 25th of December, 2023
                // Must be BEFORE "Month. Day" rule
                const dateMDYRegex = new RegExp(`\\b(${fullMonthNames})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi');
                spokenText = spokenText.replace(dateMDYRegex, (match, month, day, year) => {
                    const d = parseInt(day, 10);
                    let ordinal = day;
                    if (d === 1 || d === 21 || d === 31) ordinal += "st";
                    else if (d === 2 || d === 22) ordinal += "nd";
                    else if (d === 3 || d === 23) ordinal += "rd";
                    else ordinal += "th";

                    const key = month.charAt(0).toUpperCase() + month.slice(1).toLowerCase();
                    const fullMonth = monthMap[key] || key;

                    return `the ${ordinal} of ${fullMonth}, ${year}`;
                });

                const dateDMYRegex = new RegExp(`\\b(\\d{1,2})\\s+(${fullMonthNames})\\.?\\s+(\\d{4})\\b`, 'gi');
                spokenText = spokenText.replace(dateDMYRegex, (match, day, month, year) => {
                    const d = parseInt(day, 10);
                    let ordinal = day;
                    if (d === 1 || d === 21 || d === 31) ordinal += "st";
                    else if (d === 2 || d === 22) ordinal += "nd";
                    else if (d === 3 || d === 23) ordinal += "rd";
                    else ordinal += "th";

                    const fullMonth = monthMap[month.charAt(0).toUpperCase() + month.slice(1).toLowerCase()] || month;
                    return `the ${ordinal} of ${fullMonth}, ${year}`;
                });

                // Date normalization: Dec. 16 -> December 16th
                // We reuse the monthMap from above.
                // Regex looks for Month Abbrev (with dot) followed by Number (1-2 digits)
                // e.g. "Dec. 16", "Jan. 1"
                spokenText = spokenText.replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.\s*(\d{1,2})\b/gi, (match, month, day) => {
                    const d = parseInt(day, 10);
                    let ordinal = day;
                    if (d === 1 || d === 21 || d === 31) ordinal += "st";
                    else if (d === 2 || d === 22) ordinal += "nd";
                    else if (d === 3 || d === 23) ordinal += "rd";
                    else ordinal += "th";

                    const key = month.charAt(0).toUpperCase() + month.slice(1).toLowerCase();
                    const fullMonth = monthMap[key] || key; // Should exist in our map

                    return `${fullMonth} ${ordinal}`;
                });

                spokenText = spokenText.replace(/([a-zA-Z0-9\.]+)\-([a-zA-Z0-9\.]+)/g, '$1 $2');
                spokenText = spokenText.replace(/\b(\d)000\b/g, '$1 thousand');
                spokenText = spokenText.replace(/\b(\d{2})00\b/g, '$1 hundred');

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
                    { regex: /\bc\./g, replacement: "circa" },
                    { regex: /\bca\./gi, replacement: "circa" },
                    { regex: /\bd\./g, replacement: "died" },
                    { regex: /\bed\./g, replacement: "edited by" },
                    { regex: /\btrans\./gi, replacement: "translated by" },
                    { regex: /\brec\./gi, replacement: "recensuit" },
                    { regex: /\bsc\./gi, replacement: "namely" },
                    { regex: /\bn\./g, replacement: "note" },
                    { regex: /\bno\.\s*(?=\d)/gi, replacement: "Number " },
                    { regex: /\bpp\./gi, replacement: "pages" },
                    { regex: /\bp\.\s*(?=\d)/gi, replacement: "page " }
                ];

                for (const item of abbrevMap) {
                    spokenText = spokenText.replace(item.regex, item.replacement);
                }

                const dayMap = {
                    "Sun": "Sunday", "Mon": "Monday", "Tue": "Tuesday", "Tues": "Tuesday",
                    "Wed": "Wednesday", "Thu": "Thursday", "Thurs": "Thursday",
                    "Fri": "Friday", "Sat": "Saturday"
                };
                spokenText = spokenText.replace(/\b(Sun|Mon|Tues?|Wed|Thurs?|Fri|Sat)\./gi, (match, d1) => {
                    const key = d1.charAt(0).toUpperCase() + d1.slice(1).toLowerCase();
                    return dayMap[key] ? dayMap[key] : match;
                });


                spokenText = spokenText.replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\./gi, (match, m1) => {
                    const key = m1.charAt(0).toUpperCase() + m1.slice(1).toLowerCase();
                    return monthMap[key] ? monthMap[key] : match;
                });

                spokenText = spokenText.replace(/\b(\d+)\s*[\/\u2044]\s*(\d+)(?:rds|ths|nds|st)?\b/gi, (match, n, d) => {
                    const num = parseInt(n, 10);
                    const den = parseInt(d, 10);
                    const isFractionSlash = match.includes('\u2044');
                    const hasSpaces = match.includes(' ');

                    if (!isFractionSlash && !hasSpaces) {
                        const safeDenoms = [2, 3, 4, 5, 8, 10, 100];
                        if (!safeDenoms.includes(den)) return match;
                    }

                    let ordinal = d + "th";
                    if (den === 1) ordinal = "whole";
                    else if (den === 2) ordinal = "half";
                    else if (den === 3) ordinal = "third";
                    else if (den === 4) ordinal = "quarter";
                    else if (den === 5) ordinal = "fifth";
                    else if (den === 8) ordinal = "eighth";
                    else if (den === 9) ordinal = "ninth";
                    else if (den === 12) ordinal = "twelfth";

                    if (num !== 1) {
                        if (ordinal === "half") ordinal = "halves";
                        else ordinal += "s";
                    }

                    return `${n} ${ordinal}`;
                });

                const ordinalRomanMap = {
                    "II": "second", "III": "third", "IV": "fourth", "VI": "sixth", "VII": "seventh", "VIII": "eighth", "IX": "ninth",
                    "XI": "eleventh", "XII": "twelfth", "XIII": "thirteenth", "XIV": "fourteenth", "XV": "fifteenth",
                    "XVI": "sixteenth", "XVII": "seventeenth", "XVIII": "eighteenth", "XIX": "nineteenth", "XX": "twentieth",
                    "XXI": "twenty-first", "XXII": "twenty-second", "XXIII": "twenty-third"
                };
                const nonRegnalTriggers = new Set([
                    "Chapter", "Vol", "Volume", "Part", "Bk", "Book", "Level", "Stage", "Grade", "Phase",
                    "Section", "Class", "Type", "Model", "Mark", "Case", "Plate", "Fig", "Figure",
                    "No", "Number", "World", "War", "Apollo", "Saturn"
                ]);

                spokenText = spokenText.replace(/\b([A-Z][a-z]+)\s+(II|III|IV|VI|VII|VIII|IX|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX|XXI|XXII|XXIII)\b/g, (match, name, rom) => {
                    if (nonRegnalTriggers.has(name)) return match;
                    return ordinalRomanMap[rom] ? `${name} the ${ordinalRomanMap[rom]}` : match;
                });

                const romanMap = {
                    "II": "two", "III": "three", "IV": "four", "VI": "six", "VII": "seven", "VIII": "eight", "IX": "nine",
                    "XI": "eleven", "XII": "twelve", "XIII": "thirteen", "XIV": "fourteen", "XV": "fifteen",
                    "XVI": "sixteen", "XVII": "seventeen", "XVIII": "eighteen", "XIX": "nineteen", "XX": "twenty",
                    "XXI": "twenty-one", "XXII": "twenty-two", "XXIII": "twenty-three", "XXIV": "twenty-four", "XXV": "twenty-five",
                    "XXVI": "twenty-six", "XXVII": "twenty-seven", "XXVIII": "twenty-eight", "XXIX": "twenty-nine", "XXX": "thirty"
                };
                spokenText = spokenText.replace(/\b(II|III|IV|VI|VII|VIII|IX|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX|XXI|XXII|XXIII|XXIV|XXV|XXVI|XXVII|XXVIII|XXIX|XXX)([a-e])?\b/g, (match, rom, suffix) => {
                    const num = romanMap[rom];
                    if (!num) return match;
                    return suffix ? `${num} ${suffix}` : num;
                });

                spokenText = spokenText.replace(/\b(\d+)\s*″/g, '$1 inches');
                spokenText = spokenText.replace(/\b(\d+)\s*′/g, '$1 feet');
                // (Manual protections merged into unitMap below)
                // Improved inches disambiguation: only if preceded by number and optionally followed by period or x/by
                spokenText = spokenText.replace(/\b(\d+)\s*in\.?\b(?!\s+(?:the|a|an|my|your|his|her|its|our|their|this|that|these|those|some|any|each|every|both|either|neither|no|which|what|whose))\b/gi, (match, num) => {
                    // If it's "in" followed by common prepositions/determiners, it's likely the word "in"
                    // But if it's "in." with a dot, it's almost certainly inches
                    if (match.toLowerCase().endsWith('.') || !/\s+(?:the|a|an|my|your|his|her|its|our|their|this|that|these|those|some|any|each|every|both|either|neither|no|which|what|whose)/i.test(match)) {
                        return `${num} inches`;
                    }
                    return match;
                });

                const unitMap = {
                    "cm": "centimeters", "mm": "millimeters", "km": "kilometers",
                    "kg": "kilograms", "lb": "pounds", "oz": "ounces",
                    "MJ": "megajoules", "mJ": "millijoules", "mj": "millijoules", "kJ": "kilojoules", "kj": "kilojoules",
                    "m": "meters", "g": "grams",
                    "μm": "micrometers", "\u00B5m": "micrometers", // Support both Greek Mu and Micro Sign
                    "mW": "milliwatts", "MW": "megawatts", "kW": "kilowatts", "kw": "kilowatts", "W": "watts", "w": "watts",
                    "Ω": "ohms"
                };

                // Construct regex dynamically from keys to ensure all variations are caught
                // We no longer use 'i' flag to distinguish between MW and mW
                const units = Object.keys(unitMap).sort((a, b) => b.length - a.length).join('|');
                const unitRegex = new RegExp(`\\b(\\d+)\\s*(${units})\\b`, 'g');

                spokenText = spokenText.replace(unitRegex, (match, num, unit) => {
                    let fullUnit = unitMap[unit];

                    // Fallback for case variation logic if needed
                    if (!fullUnit) {
                        const lowerKey = unit.toLowerCase();
                        const key = Object.keys(unitMap).find(k => k.toLowerCase() === lowerKey);
                        if (key) fullUnit = unitMap[key];
                    }

                    let outUnit = fullUnit || unit;
                    if (parseInt(num) === 1 && outUnit.endsWith('s')) {
                        outUnit = outUnit.slice(0, -1);
                    }
                    return `${num} ${outUnit}`;
                });




                // --- Dynamic Pronunciation Fixes (Post-normalization to protect syntax) ---
                // We identify Proper Nouns (People, Places, Organizations) using compromise
                if (window.nlp) {
                    try {
                        let doc = window.nlp(spokenText);
                        // Identify "Topics" (People, Places, Organizations, etc.)
                        let topics = doc.topics().out('array');
                        // Remove duplicates and filter out very short names or common words if necessary
                        let uniqueTopics = [...new Set(topics)].filter(t => t.length > 2);

                        // Get custom pronunciations from global window object (populated from settings)
                        const customMap = window.kokoroCustomPronunciations || {};

                        for (const topic of uniqueTopics) {
                            const phonetic = customMap[topic];
                            if (phonetic) {
                                // Escape for regex
                                const escapedTopic = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                // Respect boundaries, including non-ASCII
                                const regex = new RegExp(`(^|[^a-zA-Z0-9\\u00C0-\\u017F])${escapedTopic}([^a-zA-Z0-9\\u00C0-\\u017F]|$)`, 'gi');
                                spokenText = spokenText.replace(regex, `$1${phonetic}$2`);
                            }
                        }
                    } catch (e) {
                        console.warn("Dynamic pronunciation identification failed", e);
                    }
                }

                // --- Phonetic expansion for Multilingual Latin text ---
                // Ensures special characters are pronounced closer to their native sounds by the TTS model
                spokenText = spokenText
                    // Slavic & Turkish (Common 'sh' and 'ch' sounds)
                    .replace(/ş|š/g, 'sh').replace(/Ş|Š/g, 'Sh')
                    .replace(/ć/g, 'tsh').replace(/Ć/g, 'Tsh')
                    .replace(/č/g, 'ch').replace(/Č/g, 'Ch')
                    .replace(/đ/g, 'dj').replace(/Đ/g, 'Dj')
                    .replace(/ž/g, 'zh').replace(/Ž/g, 'Zh')
                    // Case-specific ç: Turkish/Albanian (ch) vs French/Portuguese (s)
                    // We default to 'ch' as it is often a distinct phonetic marker, but 's' is also common.
                    // Given the goal of "better than flat", 'ch' is a stronger shift.
                    .replace(/ç/g, 'ch').replace(/Ç/g, 'Ch')
                    // Spanish & Portuguese
                    .replace(/ñ/g, 'ny').replace(/Ñ/g, 'Ny')
                    // German
                    .replace(/ä/g, 'ae').replace(/Ä/g, 'Ae')
                    .replace(/ö/g, 'oe').replace(/Ö/g, 'Oe')
                    .replace(/ü/g, 'ue').replace(/Ü/g, 'Ue')
                    .replace(/ß/g, 'ss')
                    // Turkish Soft G
                    .replace(/ğ/g, 'h').replace(/Ğ/g, 'H')
                    // Nordic
                    .replace(/ø/g, 'oe').replace(/Ø/g, 'Oe')
                    .replace(/å/g, 'aa').replace(/Å/g, 'Aa')
                    .replace(/æ/g, 'ae').replace(/Æ/g, 'Ae');

                // --- Transliteration (Last to preserve symbols like μ, °, etc during specialized normalization) ---
                if (window.transliterate) {
                    spokenText = window.transliterate(spokenText);
                }


                const sentenceObj = {
                    index: globalIndex++,
                    text: spokenText.trim(),
                    html: htmlFragment
                };
                sentences.push(sentenceObj);
                paraSentences.push(sentenceObj);
            }

            if (paraSentences.length > 0) {
                const isHeader = /^h[1-6]$/.test(block.type);
                let renderType = 'paragraph';
                if (block.type === 'list-item') renderType = 'list-item';
                else if (isHeader) renderType = block.type;

                const renderBlock = {
                    type: renderType,
                    sentences: paraSentences
                };
                if (block.isQuote) renderBlock.isQuote = true;
                if (block.type === 'list-item') {
                    renderBlock.depth = block.depth || 0;
                    renderBlock.listType = block.listType || 'ul';
                }
                renderData.push(renderBlock);
            }
        }
    });

    return { sentences, renderData };
}
