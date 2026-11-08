/** @jest-environment jsdom */
import {
    MAX_TEXT_DOCUMENT_BYTES,
    detectDocumentFormat,
    decodeTextDocument,
    parseTextDocument,
} from '../document-formats.js';

const asBuffer = bytes => Uint8Array.from(bytes).buffer;
const utf8 = text => new TextEncoder().encode(text).buffer;

describe('document formats accepted by reader (#13)', () => {
    test.each([
        ['book.epub', '', 'epub'],
        ['notes.txt', '', 'text'],
        ['notes.text', '', 'text'],
        ['README.MD', '', 'markdown'],
        ['book.markdown', '', 'markdown'],
        ['index.html', '', 'html'],
        ['index.htm', '', 'html'],
        ['index.xhtml', '', 'html'],
        ['no-extension', 'text/plain', 'text'],
        ['no-extension', 'text/markdown', 'markdown'],
        ['no-extension', 'text/html', 'html'],
        ['no-extension', 'application/xhtml+xml', 'html'],
    ])('accepts %s %s as %s', (name, type, expected) => {
        expect(detectDocumentFormat({ name, type })).toBe(expected);
    });

    test('rejects PDF and misleading unknown extensions explicitly', () => {
        expect(() => detectDocumentFormat({ name: 'book.pdf', type: 'application/pdf' }))
            .toThrow(/Unsupported format/);
        expect(() => detectDocumentFormat({ name: 'archive.docx', type: '' }))
            .toThrow(/Unsupported format/);
    });
});

describe('strict text decoding', () => {
    test('reads BOM-free and BOM-marked UTF-8 without leaking BOM', () => {
        expect(decodeTextDocument(utf8('Hello — reader.'))).toBe('Hello — reader.');
        expect(decodeTextDocument(asBuffer([0xef, 0xbb, 0xbf, 72, 105]))).toBe('Hi');
    });

    test('reads UTF-16 LE and BE when a BOM is present', () => {
        expect(decodeTextDocument(asBuffer([0xff, 0xfe, 72, 0, 105, 0])))
            .toBe('Hi');
        expect(decodeTextDocument(asBuffer([0xfe, 0xff, 0, 72, 0, 105])))
            .toBe('Hi');
    });

    test('rejects invalid encodings, null bytes, empty text, and oversized files', () => {
        expect(() => decodeTextDocument(asBuffer([0xff, 0xff])))
            .toThrow(/Cannot decode/);
        expect(() => decodeTextDocument(asBuffer([65, 0, 66])))
            .toThrow(/binary/);
        expect(() => decodeTextDocument(utf8('  \n  ')))
            .toThrow(/no readable text/);
        expect(() => decodeTextDocument(new ArrayBuffer(MAX_TEXT_DOCUMENT_BYTES + 1)))
            .toThrow(/larger than 4 MiB/);
    });
});

describe('text and markup conversion is inert and speech-safe', () => {
    test('plain text is divided into paragraphs and escapes markup', () => {
        const blocks = parseTextDocument('text', 'First <statement> & company.\n\nSecond paragraph.');
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toEqual(expect.objectContaining({
            type: 'text',
            content: 'First <statement> & company.',
            html: 'First &lt;statement&gt; &amp; company.',
        }));
    });

    test('Markdown headings, links and ordinary paragraphs become readable blocks', () => {
        const blocks = parseTextDocument('markdown',
            '# Chapter One\n\nA **bold** [link](https://example.test).\n\n- First item\n- Second item');
        expect(blocks.map(b => b.type)).toEqual(['h1', 'text', 'text']);
        expect(blocks.map(b => b.content)).toEqual([
            'Chapter One', 'A bold link.', 'First item Second item',
        ]);
        expect(blocks.every(b => !b.html.includes('https://example.test'))).toBe(true);
    });

    test('HTML extracts readable paragraphs without scripts, styles, external elements or raw markup', () => {
        const text = '<html><head><style>.foo{color:red}</style></head><body>' +
            '<h1>Title &amp; Friends</h1><p>Safe <b>text</b> <a href="https://bad">link</a>.</p>' +
            '<script>stealSecrets()</script><iframe src="https://bad"></iframe>' +
            '<p onclick="alert(1)">Another &lt;paragraph&gt;.</p></body></html>';
        const blocks = parseTextDocument('html', text);
        expect(blocks.map(b => b.content)).toEqual([
            'Title & Friends', 'Safe text link.', 'Another <paragraph>.',
        ]);
        expect(blocks.map(b => b.type)).toEqual(['h1', 'text', 'text']);
        expect(blocks.every(b => !b.html.includes('<script') &&
            !b.html.includes('onclick') && !b.html.includes('https://bad'))).toBe(true);
        expect(blocks[2].html).toContain('&lt;paragraph&gt;');
    });

    test('empty HTML body fails rather than sending a blank chapter', () => {
        expect(() => parseTextDocument('html',
            '<script>onlyScript()</script><style>body{display:none}</style>'))
            .toThrow(/no readable paragraphs/);
    });
});
