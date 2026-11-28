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
    if (!session || session._destroyed) return;
    session._destroyed = true;
    const reader = session.streamReader;
    session.streamReader = null;
    if (reader && typeof reader.cancel === 'function') {
        try { await reader.cancel(); } catch { /* ignore */ }
    }
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

function buildPdfDocumentParams(buffer, options = {}) {
    const documentParams = {
        data: new Uint8Array(buffer),
        // Local package only — never fetch fonts or cmaps from the network.
        disableFontFace: true,
        useSystemFonts: true,
        isEvalSupported: false,
        useWorkerFetch: false,
        verbosity: 0,
        ...options.documentParams,
    };
    // Packaged Adobe CMaps (binary .bcmap) so named predefined CMaps decode.
    if (typeof options.cMapUrl === 'string' && options.cMapUrl) {
        documentParams.cMapUrl = options.cMapUrl;
        documentParams.cMapPacked = options.cMapPacked !== false;
    }
    return documentParams;
}

/**
 * Create a cancellable PDF loading session immediately (before the worker
 * finishes). Callers must hold the returned handle and destroyPdfSession() it
 * on replacement / picker cancel — even while open() is still pending.
 */
export function createPdfLoadingSession(buffer, pdfjs, options = {}) {
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

    const loadingTask = pdfjs.getDocument(buildPdfDocumentParams(buffer, options));
    const session = {
        loadingTask,
        pdf: null,
        streamReader: null,
        _destroyed: false,
        attachStreamReader(reader) {
            session.streamReader = reader || null;
        },
    };

    session.open = async function openPdfLoadingSession() {
        try {
            const pdf = await loadingTask.promise;
            if (session._destroyed) {
                throw new DOMException('PDF work cancelled', 'AbortError');
            }
            if (!Number.isInteger(pdf?.numPages) || pdf.numPages < 1) {
                await destroyPdfSession(session);
                throw new Error('PDF contains no pages');
            }
            if (pdf.numPages > MAX_PDF_PAGES) {
                await destroyPdfSession(session);
                throw new Error(
                    'PDF has too many pages (maximum ' + MAX_PDF_PAGES + ')');
            }
            session.pdf = pdf;
            return session;
        } catch (error) {
            if (!session._destroyed) await destroyPdfSession(session);
            throw mapPdfJsOpenError(error);
        }
    };

    return session;
}

/**
 * Open a local PDF with the injected PDF.js getDocument API.
 * Returns `{ pdf, loadingTask }` — always dispose with destroyPdfSession().
 * Prefer createPdfLoadingSession when the caller must cancel mid-open.
 */
export async function openPdfDocument(buffer, pdfjs, options = {}) {
    const session = createPdfLoadingSession(buffer, pdfjs, options);
    return session.open();
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

function streamChunkItems(chunk) {
    if (Array.isArray(chunk?.items)) return chunk.items;
    if (Array.isArray(chunk)) return chunk;
    return chunk == null ? [] : [chunk];
}

function appendPdfTextRows(items, state, limits) {
    const maxChars = limits.maxChars;
    const maxItems = limits.maxItems;
    for (const item of items) {
        const row = rowFromTextItem(item);
        if (!row) continue;
        state.chars += row.str.length;
        if (state.rows.length >= maxItems || state.chars > maxChars) {
            throw new Error(
                'This PDF page exceeds the safe text extraction limit ' +
                '(' + maxChars + ' characters).');
        }
        state.rows.push(row);
    }
}

async function raceStreamRead(reader, isCurrent) {
    const readPromise = reader.read();
    if (typeof isCurrent !== 'function') return readPromise;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setInterval(() => {
            if (settled || isCurrent()) return;
            settled = true;
            clearInterval(timer);
            Promise.resolve(reader.cancel()).catch(() => {});
            reject(new DOMException('PDF work cancelled', 'AbortError'));
        }, 25);
        readPromise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearInterval(timer);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                clearInterval(timer);
                reject(error);
            },
        );
    });
}

async function collectRowsFromReadableStream(reader, limits) {
    const state = { rows: [], chars: 0 };
    if (typeof limits.attachStreamReader === 'function') {
        limits.attachStreamReader(reader);
    }
    try {
        while (true) {
            throwIfCancelled(limits.isCurrent);
            const { done, value } = await raceStreamRead(reader, limits.isCurrent);
            throwIfCancelled(limits.isCurrent);
            if (done) break;
            appendPdfTextRows(streamChunkItems(value), state, limits);
        }
    } catch (error) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw error;
    } finally {
        if (typeof limits.attachStreamReader === 'function') {
            limits.attachStreamReader(null);
        }
    }
    return state.rows;
}

async function collectRowsFromAsyncIterable(stream, limits) {
    const state = { rows: [], chars: 0 };
    for await (const chunk of stream) {
        throwIfCancelled(limits.isCurrent);
        appendPdfTextRows(streamChunkItems(chunk), state, limits);
    }
    return state.rows;
}

async function collectRowsFromPageStream(page, limits = {}) {
    const streamLimits = {
        maxChars: Number.isInteger(limits.maxChars)
            ? limits.maxChars : MAX_PDF_PAGE_TEXT_CHARS,
        maxItems: Number.isInteger(limits.maxItems)
            ? limits.maxItems : MAX_PDF_PAGE_TEXT_ITEMS,
        isCurrent: limits.isCurrent,
        attachStreamReader: limits.attachStreamReader,
    };
    const stream = page.streamTextContent({ includeMarkedContent: false });
    // PDF.js may return a ReadableStream or an async iterable of chunks.
    if (typeof stream?.getReader === 'function') {
        return collectRowsFromReadableStream(stream.getReader(), streamLimits);
    }
    return collectRowsFromAsyncIterable(stream, streamLimits);
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
 * top-to-bottom, left-to-right, with a coarse two-column split on body bands
 * when the partition accounts for every body item (no silent drops). Spanning
 * titles/footers and short centered headings are separate horizontal bands.
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

function classifyPdfColumnRow(row, mid, gap) {
    const rightEdge = row.x + (Number(row.width) || 0);
    if (row.x < mid - gap && rightEdge > mid + gap) return 'span';
    if (row.x < mid - gap && rightEdge <= mid + gap) return 'left';
    if (row.x > mid + gap) return 'right';
    return 'mid';
}

function tryColumnPartition(bodyRows) {
    if (bodyRows.length < 4) return null;
    const xs = bodyRows.map((row) => row.x).sort((a, b) => a - b);
    const minX = xs[0];
    const maxX = xs[xs.length - 1];
    const span = maxX - minX;
    if (!(span > 120)) return null;
    const mid = minX + span / 2;
    const gap = span * 0.08;
    const left = [];
    const right = [];
    for (const row of bodyRows) {
        const kind = classifyPdfColumnRow(row, mid, gap);
        if (kind === 'left') left.push(row);
        else if (kind === 'right') right.push(row);
        else return null;
    }
    if (left.length < 2 || right.length < 2 ||
        left.length + right.length !== bodyRows.length) {
        return null;
    }
    return left.sort(byReadingOrder).concat(right.sort(byReadingOrder));
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

    const bands = [];
    const body = [];
    for (const row of rows) {
        const kind = classifyPdfColumnRow(row, mid, gap);
        if (kind === 'left' || kind === 'right') body.push(row);
        else bands.push(row);
    }

    const orderedBody = tryColumnPartition(body);
    if (!orderedBody) {
        return [...rows].sort(byReadingOrder);
    }

    // Spanning / centered items that overlap the body vertically are ambiguous.
    const bodyMaxY = Math.max(...body.map((row) => row.y));
    const bodyMinY = Math.min(...body.map((row) => row.y));
    const above = [];
    const below = [];
    for (const row of bands) {
        if (row.y > bodyMaxY + 4) above.push(row);
        else if (row.y < bodyMinY - 4) below.push(row);
        else return [...rows].sort(byReadingOrder);
    }
    return above.sort(byReadingOrder)
        .concat(orderedBody)
        .concat(below.sort(byReadingOrder));
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
 * Session-wide character budget: each page counts at most once as the user
 * navigates. Keeps open-time probing cheap (early exit) while still enforcing
 * MAX_PDF_DOCUMENT_TEXT_CHARS across the document lifetime.
 */
export function createPdfDocumentCharBudget() {
    return { chars: 0, countedPages: new Set() };
}

export function accountPdfPageChars(budget, pageNumber, blocks) {
    if (!budget || budget.countedPages.has(pageNumber)) return;
    const pageChars = (Array.isArray(blocks) ? blocks : []).reduce(
        (sum, block) => sum + String(block?.content || '').length, 0);
    const next = budget.chars + pageChars;
    if (next > MAX_PDF_DOCUMENT_TEXT_CHARS) {
        throw new Error(
            'This PDF exceeds the safe document text extraction limit.');
    }
    budget.chars = next;
    budget.countedPages.add(pageNumber);
}

/**
 * Probe pages (up to the document page count / MAX_PDF_PAGES) for extractable
 * text so image-only PDFs fail closed at open. Cancel via isCurrent().
 * Returns `{ firstTextPage }` for fresh-open activation.
 */
export async function assertPdfHasExtractableText(pdf, options = {}) {
    const probePages = Math.min(
        pdf.numPages,
        MAX_PDF_PAGES,
        Number.isInteger(options.probePages) ? options.probePages : pdf.numPages,
    );
    for (let pageNumber = 1; pageNumber <= probePages; pageNumber++) {
        throwIfCancelled(options.isCurrent);
        try {
            const blocks = await extractPdfPageBlocks(pdf, pageNumber, {
                maxChars: MAX_PDF_PAGE_TEXT_CHARS,
                isCurrent: options.isCurrent,
                attachStreamReader: options.attachStreamReader,
            });
            if (options.charBudget) {
                accountPdfPageChars(options.charBudget, pageNumber, blocks);
            }
            return { firstTextPage: pageNumber };
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
    throw new Error(
        'This PDF has no extractable text. Scanned or image-only PDFs ' +
        'are not supported without OCR.');
}
