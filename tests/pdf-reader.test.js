/** @jest-environment node */
/**
 * #198 local text PDF extraction contracts (packaged PDF.js, no OCR).
 * PDF.js itself is ESM-only; open/extract paths are exercised with an
 * injectable getDocument/getPage fake so Jest stays CommonJS-friendly.
 */
import {
    MAX_PDF_DOCUMENT_BYTES,
    MAX_PDF_PAGES,
    assertPdfHasExtractableText,
    blocksFromPdfTextContent,
    buildPdfPageToc,
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

    test('uses left-then-right column order when clusters are clear', () => {
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
});

function fakePdfjs({ numPages = 1, textByPage = {}, openError = null } = {}) {
    return {
        getDocument() {
            if (openError) {
                return { promise: Promise.reject(openError), destroy() {} };
            }
            const pdf = {
                numPages,
                async getPage(pageNumber) {
                    return {
                        async getTextContent() {
                            const items = textByPage[pageNumber] || [];
                            return { items };
                        },
                        cleanup() {},
                    };
                },
                async cleanup() {},
            };
            return { promise: Promise.resolve(pdf), destroy() {} };
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
        const pdf = await openPdfDocument(new ArrayBuffer(16), pdfjs);
        await assertPdfHasExtractableText(pdf);
        const page1 = await extractPdfPageBlocks(pdf, 1);
        const page2 = await extractPdfPageBlocks(pdf, 2);
        expect(page1[0].content).toMatch(/Hello first page/);
        expect(page2[0].content).toMatch(/Second page text/);
        await pdf.cleanup();
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
        await expect(assertPdfHasExtractableText(empty))
            .rejects.toThrow(/no extractable text|image-only/i);
        await expect(extractPdfPageBlocks(empty, 1))
            .rejects.toThrow(/no extractable text|image-only/i);
        await empty.cleanup();
    });
});

describe('reader wiring keeps PDF paths out of overlay/audio-export', () => {
    test('reader.js loads PDF through pdf-reader helpers', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '..', 'reader.js'), 'utf8');
        expect(source).toContain("from './pdf-reader.js'");
        expect(source).toContain('loadPdfDocument');
        expect(source).toContain('ensurePdfjs');
        expect(source).toContain('pdf.min.mjs');
        expect(source).toContain('pdf.worker.min.mjs');
        expect(source).not.toContain('audio-export');
    });
});
