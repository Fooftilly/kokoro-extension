/**
 * Local text-based PDF extraction for the packaged reader (#198).
 * Uses extension-bundled PDF.js only — no remote scripts, uploads, or OCR.
 */

export const MAX_PDF_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;
export const MAX_PDF_PAGE_TEXT_CHARS = 100_000;
export const MAX_PDF_DOCUMENT_TEXT_CHARS = 2_000_000;

const PDF_PAGE_HREF_PREFIX = 'pdf:page:';

function escapeSpeechText(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function speechBlock(type, text) {
    const content = String(text || '').replace(/\s+/g, ' ').trim();
    return content
        ? { type, content, html: escapeSpeechText(content), ids: [] }
        : null;
}

/** Stable chapter href for page N (1-based). */
export function pdfPageHref(pageNumber) {
    const n = Number(pageNumber);
    if (!Number.isInteger(n) || n < 1) {
        throw new Error('PDF page number must be a positive integer');
    }
    return PDF_PAGE_HREF_PREFIX + n;
}

export function parsePdfPageHref(href) {
    const match = /^pdf:page:(\d+)$/.exec(String(href || ''));
    if (!match) return null;
    const pageNumber = Number(match[1]);
    return Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : null;
}

export function buildPdfPageToc(pageCount, title = 'PDF') {
    const count = Number(pageCount);
    if (!Number.isInteger(count) || count < 1) {
        throw new Error('PDF contains no pages');
    }
    if (count > MAX_PDF_PAGES) {
        throw new Error(
            'PDF has too many pages (maximum ' + MAX_PDF_PAGES + ')');
    }
    const labelBase = String(title || 'PDF').trim() || 'PDF';
    return Array.from({ length: count }, (_, index) => {
        const pageNumber = index + 1;
        return {
            href: pdfPageHref(pageNumber),
            label: labelBase + ' · page ' + pageNumber,
        };
    });
}

export function mapPdfJsOpenError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || error || '');
    if (name === 'PasswordException' || /password/i.test(message)) {
        return new Error(
            'This PDF is password-protected. Remove the password and try again.');
    }
    if (name === 'InvalidPDFException' || /invalid\s*pdf/i.test(message)) {
        return new Error('This file is not a valid PDF or the file is corrupt.');
    }
    if (name === 'MissingPDFException') {
        return new Error('This file is not a valid PDF or the file is corrupt.');
    }
    if (name === 'UnexpectedResponseException') {
        return new Error('Unable to open this PDF.');
    }
    return error instanceof Error ? error : new Error(message || 'Unable to open this PDF.');
}

/**
 * Open a local PDF with the injected PDF.js getDocument API.
 * Caller must dispose via pdfDocument.cleanup() when replacing files.
 */
export async function openPdfDocument(buffer, pdfjs, options = {}) {
    if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]') {
        throw new Error('The selected PDF has no readable binary data');
    }
    if (buffer.byteLength > MAX_PDF_DOCUMENT_BYTES) {
        throw new Error(
            'PDF files larger than 32 MiB are not supported');
    }
    if (!pdfjs || typeof pdfjs.getDocument !== 'function') {
        throw new Error('Packaged PDF.js reader is unavailable');
    }

    const data = new Uint8Array(buffer);
    let loadingTask;
    try {
        loadingTask = pdfjs.getDocument({
            data,
            // Local package only — never fetch fonts or cmaps from the network.
            disableFontFace: true,
            useSystemFonts: true,
            isEvalSupported: false,
            useWorkerFetch: false,
            verbosity: 0,
            ...options.documentParams,
        });
        const pdf = await loadingTask.promise;
        if (!Number.isInteger(pdf?.numPages) || pdf.numPages < 1) {
            await safeCleanup(pdf);
            throw new Error('PDF contains no pages');
        }
        if (pdf.numPages > MAX_PDF_PAGES) {
            await safeCleanup(pdf);
            throw new Error(
                'PDF has too many pages (maximum ' + MAX_PDF_PAGES + ')');
        }
        return pdf;
    } catch (error) {
        if (loadingTask && typeof loadingTask.destroy === 'function') {
            try { loadingTask.destroy(); } catch { /* ignore */ }
        }
        throw mapPdfJsOpenError(error);
    }
}

async function safeCleanup(pdf) {
    if (pdf && typeof pdf.cleanup === 'function') {
        try { await pdf.cleanup(); } catch { /* ignore */ }
    }
}

function collectPdfTextRows(textContent) {
    const items = Array.isArray(textContent?.items) ? textContent.items : [];
    const rows = [];
    for (const item of items) {
        const str = String(item?.str || '');
        if (!str.trim()) continue;
        const transform = Array.isArray(item.transform) ? item.transform : null;
        rows.push({
            str,
            x: transform ? Number(transform[4]) || 0 : 0,
            y: transform ? Number(transform[5]) || 0 : 0,
            width: Number(item.width) || 0,
        });
    }
    return rows;
}

function blocksFromParagraphs(paragraphs, maxChars) {
    const blocks = [];
    let used = 0;
    for (const paragraph of paragraphs) {
        const remaining = maxChars - used;
        if (remaining <= 0) break;
        const clipped = paragraph.length > remaining
            ? paragraph.slice(0, remaining)
            : paragraph;
        const entry = speechBlock('text', clipped);
        if (!entry) continue;
        used += entry.content.length;
        blocks.push(entry);
        if (paragraph.length > remaining) break;
    }
    return blocks;
}

/**
 * Convert PDF.js text items into speech blocks with basic reading order:
 * top-to-bottom, left-to-right, with a coarse two-column split when widths
 * clearly separate into left/right clusters.
 */
export function blocksFromPdfTextContent(textContent, options = {}) {
    const maxChars = Number.isInteger(options.maxChars)
        ? options.maxChars
        : MAX_PDF_PAGE_TEXT_CHARS;
    const rows = collectPdfTextRows(textContent);
    if (!rows.length) return [];
    return blocksFromParagraphs(
        groupPdfParagraphs(orderPdfTextItems(rows)), maxChars);
}

function orderPdfTextItems(rows) {
    if (rows.length < 4) {
        return [...rows].sort((a, b) => (b.y - a.y) || (a.x - b.x));
    }
    const xs = rows.map((row) => row.x).sort((a, b) => a - b);
    const minX = xs[0];
    const maxX = xs[xs.length - 1];
    const span = maxX - minX;
    if (!(span > 120)) {
        return [...rows].sort((a, b) => (b.y - a.y) || (a.x - b.x));
    }
    const mid = minX + span / 2;
    const left = rows.filter((row) => row.x < mid - span * 0.08);
    const right = rows.filter((row) => row.x > mid + span * 0.08);
    // Require a meaningful split into both columns before using column order.
    if (left.length < 2 || right.length < 2 ||
        left.length + right.length < rows.length * 0.7) {
        return [...rows].sort((a, b) => (b.y - a.y) || (a.x - b.x));
    }
    const byReading = (a, b) => (b.y - a.y) || (a.x - b.x);
    return [...left].sort(byReading).concat([...right].sort(byReading));
}

function groupPdfParagraphs(orderedItems) {
    if (!orderedItems.length) return [];
    const paragraphs = [];
    let current = orderedItems[0].str;
    let prev = orderedItems[0];
    for (let i = 1; i < orderedItems.length; i++) {
        const item = orderedItems[i];
        const yGap = Math.abs(prev.y - item.y);
        const sameLine = yGap < 4;
        if (sameLine) {
            current += (/[\s-]$/.test(current) || /^\s/.test(item.str) ? '' : ' ') +
                item.str;
        } else if (yGap < 16) {
            current += (/[\s-]$/.test(current) ? '' : ' ') + item.str;
        } else {
            const trimmed = current.replace(/\s+/g, ' ').trim();
            if (trimmed) paragraphs.push(trimmed);
            current = item.str;
        }
        prev = item;
    }
    const trimmed = current.replace(/\s+/g, ' ').trim();
    if (trimmed) paragraphs.push(trimmed);
    return paragraphs;
}

export async function extractPdfPageBlocks(pdf, pageNumber, options = {}) {
    const n = Number(pageNumber);
    if (!pdf || typeof pdf.getPage !== 'function') {
        throw new Error('PDF document is not open');
    }
    if (!Number.isInteger(n) || n < 1 || n > pdf.numPages) {
        throw new Error('PDF page is out of range');
    }
    const page = await pdf.getPage(n);
    let textContent;
    try {
        textContent = await page.getTextContent({
            // Avoid marked-content noise; keep natural reading strings.
            includeMarkedContent: false,
        });
    } finally {
        if (typeof page.cleanup === 'function') {
            try { page.cleanup(); } catch { /* ignore */ }
        }
    }
    const blocks = blocksFromPdfTextContent(textContent, options);
    if (!blocks.length) {
        throw new Error(
            'This PDF page has no extractable text. Scanned or image-only ' +
            'PDFs are not supported without OCR.');
    }
    return blocks;
}

/**
 * Probe the first pages for any extractable text so image-only PDFs fail
 * closed at open time rather than on every page click.
 */
export async function assertPdfHasExtractableText(pdf, options = {}) {
    const probePages = Math.min(
        pdf.numPages,
        Number.isInteger(options.probePages) ? options.probePages : 3,
    );
    let sawText = false;
    for (let pageNumber = 1; pageNumber <= probePages; pageNumber++) {
        try {
            await extractPdfPageBlocks(pdf, pageNumber, {
                maxChars: MAX_PDF_PAGE_TEXT_CHARS,
            });
            sawText = true;
            break;
        } catch (error) {
            if (!/no extractable text/i.test(String(error?.message || error))) {
                throw error;
            }
        }
    }
    if (!sawText) {
        throw new Error(
            'This PDF has no extractable text. Scanned or image-only PDFs ' +
            'are not supported without OCR.');
    }
    return true;
}
