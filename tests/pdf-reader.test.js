/** @jest-environment node */
/**
 * #198 local text PDF extraction contracts (packaged PDF.js, no OCR).
 * PDF.js itself is ESM-only; open/extract paths are exercised with an
 * injectable getDocument/getPage fake so Jest stays CommonJS-friendly.
 */
import {
    MAX_PDF_DOCUMENT_BYTES,
    MAX_PDF_PAGES,
    MAX_PDF_PAGE_TEXT_CHARS,
    assertPdfHasExtractableText,
    blocksFromPdfTextContent,
    buildPdfPageToc,
    destroyPdfSession,
    extractPdfPageBlocks,
    mapPdfJsOpenError,
    openPdfDocument,
    parsePdfPageHref,
    pdfPageHref,
} from '../pdf-reader.js';

describe('pdf page href helpers (#198)', () => {
    test('builds and parses page hrefs', () => {
        expect(pdfPageHref(1)).toBe('pdf:page:1');
        expect(parsePdfPageHref('pdf:page:12')).toBe(12);
        expect(parsePdfPageHref('document:0')).toBeNull();
        expect(() => pdfPageHref(0)).toThrow(/positive integer/);
    });

    test('buildPdfPageToc fails closed on empty or oversized page counts', () => {
        expect(buildPdfPageToc(2, 'Paper.pdf')).toEqual([
            { href: 'pdf:page:1', label: 'Paper.pdf · page 1' },
            { href: 'pdf:page:2', label: 'Paper.pdf · page 2' },
        ]);
        expect(() => buildPdfPageToc(0)).toThrow(/no pages/);
        expect(() => buildPdfPageToc(MAX_PDF_PAGES + 1)).toThrow(/too many pages/);
    });
});

describe('pdf.js error mapping', () => {
    test('maps password and corrupt failures to clear user errors', () => {
        expect(mapPdfJsOpenError({ name: 'PasswordException', message: 'Need password' })
            .message).toMatch(/password-protected/i);
        expect(mapPdfJsOpenError({ name: 'InvalidPDFException', message: 'Invalid PDF' })
            .message).toMatch(/not a valid PDF|corrupt/i);
    });
});

describe('text item ordering and paragraph grouping', () => {
    test('orders single-column items top-to-bottom and joins lines', () => {
        const blocks = blocksFromPdfTextContent({
            items: [
                { str: 'Second', transform: [1, 0, 0, 1, 72, 680], width: 40 },
                { str: 'First', transform: [1, 0, 0, 1, 72, 720], width: 40 },
                { str: 'line.', transform: [1, 0, 0, 1, 120, 680], width: 30 },
            ],
        });
        expect(blocks.map((b) => b.content)).toEqual(['First', 'Second line.']);
        expect(blocks[0].html).toBe('First');
    });

    test('uses left-then-right column order when every item is partitioned', () => {
        const blocks = blocksFromPdfTextContent({
            items: [
                { str: 'L1', transform: [1, 0, 0, 1, 40, 700], width: 20 },
                { str: 'L2', transform: [1, 0, 0, 1, 40, 660], width: 20 },
                { str: 'R1', transform: [1, 0, 0, 1, 320, 700], width: 20 },
                { str: 'R2', transform: [1, 0, 0, 1, 320, 660], width: 20 },
            ],
        });
        expect(blocks.map((b) => b.content).join(' ')).toBe('L1 L2 R1 R2');
    });

    test('keeps centered headings when a two-column split would drop middle text', () => {
        const blocks = blocksFromPdfTextContent({
            items: [
                { str: 'Centered heading', transform: [1, 0, 0, 1, 180, 740], width: 80 },
                { str: 'L1', transform: [1, 0, 0, 1, 40, 700], width: 20 },
                { str: 'L2', transform: [1, 0, 0, 1, 40, 660], width: 20 },
                { str: 'R1', transform: [1, 0, 0, 1, 320, 700], width: 20 },
                { str: 'R2', transform: [1, 0, 0, 1, 320, 660], width: 20 },
            ],
        });
        const joined = blocks.map((b) => b.content).join(' ');
        expect(joined).toContain('Centered heading');
        expect(joined).toContain('L1');
        expect(joined).toContain('L2');
        expect(joined).toContain('R1');
        expect(joined).toContain('R2');
        // No duplicates from a partial column partition.
        expect(joined.match(/Centered heading/g)).toHaveLength(1);
        expect(joined.match(/\bL1\b/g)).toHaveLength(1);
    });

    test('rejects pages that exceed the extraction character limit', () => {
        const huge = 'x'.repeat(MAX_PDF_PAGE_TEXT_CHARS + 10);
        expect(() => blocksFromPdfTextContent({
            items: [{ str: huge, transform: [1, 0, 0, 1, 72, 720], width: 10 }],
        })).toThrow(/safe text extraction limit/);
    });
});

function fakePdfjs({
    numPages = 1,
    textByPage = {},
    openError = null,
    streamByPage = null,
} = {}) {
    const destroyed = { count: 0 };
    return {
        destroyed,
        getDocument() {
            if (openError) {
                return {
                    promise: Promise.reject(openError),
                    async destroy() { destroyed.count += 1; },
                };
            }
            const pdf = {
                numPages,
                async getPage(pageNumber) {
                    const items = textByPage[pageNumber] || [];
                    return {
                        async getTextContent() {
                            return { items };
                        },
                        streamTextContent: streamByPage
                            ? () => streamByPage(pageNumber, items)
                            : undefined,
                        cleanup() {},
                    };
                },
                async cleanup() {},
            };
            const loadingTask = {
                promise: Promise.resolve(pdf),
                async destroy() { destroyed.count += 1; },
            };
            return loadingTask;
        },
    };
}

describe('openPdfDocument and page extraction with injectable PDF.js', () => {
    test('opens a multi-page text PDF and extracts pages on demand', async () => {
        const pdfjs = fakePdfjs({
            numPages: 2,
            textByPage: {
                1: [{ str: 'Hello first page.', transform: [1, 0, 0, 1, 72, 720], width: 80 }],
                2: [{ str: 'Second page text.', transform: [1, 0, 0, 1, 72, 720], width: 80 }],
            },
        });
        const session = await openPdfDocument(new ArrayBuffer(16), pdfjs);
        await assertPdfHasExtractableText(session.pdf);
        const page1 = await extractPdfPageBlocks(session.pdf, 1);
        const page2 = await extractPdfPageBlocks(session.pdf, 2);
        expect(page1[0].content).toMatch(/Hello first page/);
        expect(page2[0].content).toMatch(/Second page text/);
        await destroyPdfSession(session);
        expect(pdfjs.destroyed.count).toBe(1);
    });

    test('finds text after blank introductory pages within the page bound', async () => {
        const pdfjs = fakePdfjs({
            numPages: 4,
            textByPage: {
                1: [],
                2: [],
                3: [],
                4: [{ str: 'Late text page.', transform: [1, 0, 0, 1, 72, 720], width: 80 }],
            },
        });
        const session = await openPdfDocument(new ArrayBuffer(16), pdfjs);
        await expect(assertPdfHasExtractableText(session.pdf)).resolves.toBe(true);
        const page4 = await extractPdfPageBlocks(session.pdf, 4);
        expect(page4[0].content).toMatch(/Late text page/);
        await destroyPdfSession(session);
    });

    test('rejects oversized, corrupt, password, and image-only PDFs', async () => {
        await expect(openPdfDocument(new ArrayBuffer(MAX_PDF_DOCUMENT_BYTES + 1), fakePdfjs()))
            .rejects.toThrow(/32 MiB/);
        await expect(openPdfDocument(new ArrayBuffer(8), fakePdfjs({
            openError: { name: 'InvalidPDFException', message: 'Invalid PDF structure.' },
        }))).rejects.toThrow(/not a valid PDF|corrupt/i);
        await expect(openPdfDocument(new ArrayBuffer(8), fakePdfjs({
            openError: { name: 'PasswordException', message: 'No password given' },
        }))).rejects.toThrow(/password-protected/i);

        const empty = await openPdfDocument(new ArrayBuffer(8), fakePdfjs({
            numPages: 1,
            textByPage: { 1: [] },
        }));
        await expect(assertPdfHasExtractableText(empty.pdf))
            .rejects.toThrow(/no extractable text|image-only/i);
        await expect(extractPdfPageBlocks(empty.pdf, 1))
            .rejects.toThrow(/no extractable text|image-only/i);
        await destroyPdfSession(empty);
    });

    test('streamTextContent cancels early when the page exceeds the char limit', async () => {
        let cancelled = false;
        const pdfjs = fakePdfjs({
            numPages: 1,
            textByPage: {},
            streamByPage() {
                const chunks = [
                    { items: [{ str: 'a'.repeat(60_000), transform: [1, 0, 0, 1, 10, 700], width: 10 }] },
                    { items: [{ str: 'b'.repeat(60_000), transform: [1, 0, 0, 1, 10, 680], width: 10 }] },
                ];
                let index = 0;
                return {
                    getReader() {
                        return {
                            async read() {
                                if (index >= chunks.length) return { done: true, value: undefined };
                                return { done: false, value: chunks[index++] };
                            },
                            async cancel() { cancelled = true; },
                        };
                    },
                };
            },
        });
        const session = await openPdfDocument(new ArrayBuffer(8), pdfjs);
        await expect(extractPdfPageBlocks(session.pdf, 1))
            .rejects.toThrow(/safe text extraction limit/);
        expect(cancelled).toBe(true);
        await destroyPdfSession(session);
    });

    test('destroyPdfSession destroys the loading task on replacement', async () => {
        const first = fakePdfjs({
            numPages: 1,
            textByPage: {
                1: [{ str: 'One', transform: [1, 0, 0, 1, 72, 720], width: 20 }],
            },
        });
        const second = fakePdfjs({
            numPages: 1,
            textByPage: {
                1: [{ str: 'Two', transform: [1, 0, 0, 1, 72, 720], width: 20 }],
            },
        });
        const sessionA = await openPdfDocument(new ArrayBuffer(8), first);
        const sessionB = await openPdfDocument(new ArrayBuffer(8), second);
        await destroyPdfSession(sessionA);
        await destroyPdfSession(sessionB);
        expect(first.destroyed.count).toBe(1);
        expect(second.destroyed.count).toBe(1);
    });

    test('assertPdfHasExtractableText aborts when isCurrent becomes false', async () => {
        const pdfjs = fakePdfjs({
            numPages: 3,
            textByPage: { 1: [], 2: [], 3: [] },
        });
        const session = await openPdfDocument(new ArrayBuffer(8), pdfjs);
        await expect(assertPdfHasExtractableText(session.pdf, {
            isCurrent: () => false,
        })).rejects.toMatchObject({ name: 'AbortError' });
        await destroyPdfSession(session);
    });
});

describe('reader wiring keeps PDF paths out of overlay/audio-export', () => {
    test('reader.js destroys PDF loading tasks and cancels probes', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '..', 'reader.js'), 'utf8');
        expect(source).toContain("from './pdf-reader.js'");
        expect(source).toContain('destroyPdfSession');
        expect(source).toContain('loadingTask');
        expect(source).toContain('isCurrent');
        expect(source).not.toContain('audio-export');
    });
});
