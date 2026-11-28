/**
 * Local text-based PDF extraction for the packaged reader (#198).
 * Uses extension-bundled PDF.js only — no remote scripts, uploads, or OCR.
 */

export const MAX_PDF_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;
export const MAX_PDF_PAGE_TEXT_CHARS = 100_000;
export const MAX_PDF_DOCUMENT_TEXT_CHARS = 2_000_000;
export const MAX_PDF_PAGE_TEXT_ITEMS = 20_000;

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

function throwIfCancelled(isCurrent) {
    if (typeof isCurrent === 'function' && !isCurrent()) {
        throw new DOMException('PDF work cancelled', 'AbortError');
    }
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
    if (error?.name === 'AbortError') return error;
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

export async function destroyPdfSession(session) {
    if (!session) return;
    const task = session.loadingTask;
    const pdf = session.pdf;
    if (task && typeof task.destroy === 'function') {
        try { await task.destroy(); } catch { /* ignore */ }
        return;
    }
    if (pdf && typeof pdf.cleanup === 'function') {
        try { await pdf.cleanup(); } catch { /* ignore */ }
    }
}

/**
 * Open a local PDF with the injected PDF.js getDocument API.
 * Returns `{ pdf, loadingTask }` — always dispose with destroyPdfSession().
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
            await destroyPdfSession({ pdf, loadingTask });
            throw new Error('PDF contains no pages');
        }
        if (pdf.numPages > MAX_PDF_PAGES) {
            await destroyPdfSession({ pdf, loadingTask });
            throw new Error(
                'PDF has too many pages (maximum ' + MAX_PDF_PAGES + ')');
        }
        return { pdf, loadingTask };
    } catch (error) {
        if (loadingTask) await destroyPdfSession({ loadingTask });
        throw mapPdfJsOpenError(error);
    }
}

function rowFromTextItem(item) {
    const str = String(item?.str || '');
    if (!str.trim()) return null;
    const transform = Array.isArray(item.transform) ? item.transform : null;
    return {
        str,
        x: transform ? Number(transform[4]) || 0 : 0,
        y: transform ? Number(transform[5]) || 0 : 0,
        width: Number(item.width) || 0,
    };
}

function collectPdfTextRows(textContent, limits = {}) {
    const maxChars = Number.isInteger(limits.maxChars)
        ? limits.maxChars : MAX_PDF_PAGE_TEXT_CHARS;
    const maxItems = Number.isInteger(limits.maxItems)
        ? limits.maxItems : MAX_PDF_PAGE_TEXT_ITEMS;
    const items = Array.isArray(textContent?.items) ? textContent.items : [];
    const rows = [];
    let chars = 0;
    for (const item of items) {
        const row = rowFromTextItem(item);
        if (!row) continue;
        chars += row.str.length;
        if (rows.length >= maxItems || chars > maxChars) {
            throw new Error(
                'This PDF page exceeds the safe text extraction limit ' +
                '(' + maxChars + ' characters).');
        }
        rows.push(row);
    }
    return rows;
}

async function collectRowsFromPageStream(page, limits = {}) {
    const maxChars = Number.isInteger(limits.maxChars)
        ? limits.maxChars : MAX_PDF_PAGE_TEXT_CHARS;
    const maxItems = Number.isInteger(limits.maxItems)
        ? limits.maxItems : MAX_PDF_PAGE_TEXT_ITEMS;
    const isCurrent = limits.isCurrent;
    const rows = [];
    let chars = 0;
    const stream = page.streamTextContent({ includeMarkedContent: false });
    // PDF.js may return a ReadableStream or an async iterable of chunks.
    const reader = typeof stream?.getReader === 'function'
        ? stream.getReader()
        : null;
    if (reader) {
        while (true) {
            throwIfCancelled(isCurrent);
            const { done, value } = await reader.read();
            if (done) break;
            const items = Array.isArray(value?.items) ? value.items
                : (Array.isArray(value) ? value : [value]);
            for (const item of items) {
                const row = rowFromTextItem(item);
                if (!row) continue;
                chars += row.str.length;
                if (rows.length >= maxItems || chars > maxChars) {
                    try { await reader.cancel(); } catch { /* ignore */ }
                    throw new Error(
                        'This PDF page exceeds the safe text extraction limit ' +
                        '(' + maxChars + ' characters).');
                }
                rows.push(row);
            }
        }
        return rows;
    }
    for await (const chunk of stream) {
        throwIfCancelled(isCurrent);
        const items = Array.isArray(chunk?.items) ? chunk.items
            : (Array.isArray(chunk) ? chunk : [chunk]);
        for (const item of items) {
            const row = rowFromTextItem(item);
            if (!row) continue;
            chars += row.str.length;
            if (rows.length >= maxItems || chars > maxChars) {
                throw new Error(
                    'This PDF page exceeds the safe text extraction limit ' +
                    '(' + maxChars + ' characters).');
            }
            rows.push(row);
        }
    }
    return rows;
}

function blocksFromParagraphs(paragraphs) {
    const blocks = [];
    for (const paragraph of paragraphs) {
        const entry = speechBlock('text', paragraph);
        if (entry) blocks.push(entry);
    }
    return blocks;
}

/**
 * Convert PDF.js text items into speech blocks with basic reading order:
 * top-to-bottom, left-to-right, with a coarse two-column split only when the
 * partition accounts for every item (no silent drops).
 */
export function blocksFromPdfTextContent(textContent, options = {}) {
    const rows = Array.isArray(textContent?.items)
        ? collectPdfTextRows(textContent, options)
        : (Array.isArray(textContent) ? textContent : []);
    if (!rows.length) return [];
    return blocksFromParagraphs(groupPdfParagraphs(orderPdfTextItems(rows)));
}

function byReadingOrder(a, b) {
    return (b.y - a.y) || (a.x - b.x);
}

function orderPdfTextItems(rows) {
    if (rows.length < 4) {
        return [...rows].sort(byReadingOrder);
    }
    const xs = rows.map((row) => row.x).sort((a, b) => a - b);
    const minX = xs[0];
    const maxX = xs[xs.length - 1];
    const span = maxX - minX;
    if (!(span > 120)) {
        return [...rows].sort(byReadingOrder);
    }
    const mid = minX + span / 2;
    const gap = span * 0.08;
    const left = [];
    const right = [];
    for (const row of rows) {
        if (row.x < mid - gap) left.push(row);
        else if (row.x > mid + gap) right.push(row);
        else {
            // Middle/spanning items break a clean two-column partition.
            return [...rows].sort(byReadingOrder);
        }
    }
    // Only column-order when every item is assigned exactly once.
    if (left.length < 2 || right.length < 2 ||
        left.length + right.length !== rows.length) {
        return [...rows].sort(byReadingOrder);
    }
    return left.sort(byReadingOrder).concat(right.sort(byReadingOrder));
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
    throwIfCancelled(options.isCurrent);
    const page = await pdf.getPage(n);
    let rows;
    try {
        throwIfCancelled(options.isCurrent);
        if (typeof page.streamTextContent === 'function') {
            rows = await collectRowsFromPageStream(page, options);
        } else {
            const textContent = await page.getTextContent({
                includeMarkedContent: false,
            });
            throwIfCancelled(options.isCurrent);
            rows = collectPdfTextRows(textContent, options);
        }
    } finally {
        if (typeof page.cleanup === 'function') {
            try { page.cleanup(); } catch { /* ignore */ }
        }
    }
    const blocks = blocksFromParagraphs(groupPdfParagraphs(orderPdfTextItems(rows)));
    if (!blocks.length) {
        throw new Error(
            'This PDF page has no extractable text. Scanned or image-only ' +
            'PDFs are not supported without OCR.');
    }
    return blocks;
}

/**
 * Probe pages (up to the document page count / MAX_PDF_PAGES) for extractable
 * text so image-only PDFs fail closed at open. Cancel via isCurrent().
 */
export async function assertPdfHasExtractableText(pdf, options = {}) {
    const probePages = Math.min(
        pdf.numPages,
        MAX_PDF_PAGES,
        Number.isInteger(options.probePages) ? options.probePages : pdf.numPages,
    );
    let sawText = false;
    let documentChars = 0;
    for (let pageNumber = 1; pageNumber <= probePages; pageNumber++) {
        throwIfCancelled(options.isCurrent);
        try {
            const blocks = await extractPdfPageBlocks(pdf, pageNumber, {
                maxChars: MAX_PDF_PAGE_TEXT_CHARS,
                isCurrent: options.isCurrent,
            });
            documentChars += blocks.reduce(
                (sum, block) => sum + block.content.length, 0);
            if (documentChars > MAX_PDF_DOCUMENT_TEXT_CHARS) {
                throw new Error(
                    'This PDF exceeds the safe document text extraction limit.');
            }
            sawText = true;
            break;
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            if (/exceeds the safe .*extraction limit/i.test(
                String(error?.message || error))) {
                throw error;
            }
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
