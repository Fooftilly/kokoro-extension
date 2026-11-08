/** @jest-environment jsdom */
import { TextEncoder, TextDecoder } from 'util';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

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
        ['report.DOCX', '', 'docx'],
        ['no-extension', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
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

    test('rejects PDF, legacy DOC, and misleading unknown extensions explicitly', () => {
        expect(() => detectDocumentFormat({ name: 'book.pdf', type: 'application/pdf' }))
            .toThrow(/Unsupported format/);
        expect(() => detectDocumentFormat({ name: 'archive.doc', type: '' }))
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
        expect(blocks[1]).toEqual({
            type: 'text', content: 'A bold link.',
            html: 'A bold link.', ids: [],
        });
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
        expect(blocks[2]).toEqual({
            type: 'text', content: 'Another <paragraph>.',
            html: 'Another &lt;paragraph&gt;.', ids: [],
        });
        expect(blocks[1].html).toBe('Safe text link.');
    });

    test('nested HTML scripts and styles are discarded before text extraction', () => {
        const blocks = parseTextDocument('html',
            '<p>Hello<script>sendCredentials()</script> reader' +
            '<style>privateCSS()</style> again.</p>' +
            '<blockquote>Opening <iframe src="https://external.invalid">hidden fallback</iframe>end.</blockquote>');
        expect(blocks.map(b => b.content)).toEqual([
            'Hello reader again.', 'Opening end.',
        ]);
        expect(blocks.map(b => b.html)).toEqual([
            'Hello reader again.', 'Opening end.',
        ]);
    });

    test('line breaks and nested paragraphs keep word boundaries', () => {
        const blocks = parseTextDocument('html',
            '<p>First line<br>Second line</p>' +
            '<blockquote><p>First paragraph.</p><p>Second paragraph.</p></blockquote>');
        expect(blocks.map(b => b.content)).toEqual([
            'First line Second line', 'First paragraph. Second paragraph.',
        ]);
    });

    test('preserves inline word fragments and punctuation inside non-paragraph containers', () => {
        const blocks = parseTextDocument('html',
            '<div>Read<em>er</em>.</div>' +
            'Bare <strong>body</strong> text.' +
            '<section>Introduction <span>to</span> text.' +
            '<p>Separate paragraph.</p>Following <i>text</i>.</section>');
        expect(blocks.map(b => b.content)).toEqual([
            'Reader.', 'Bare body text.', 'Introduction to text.',
            'Separate paragraph.', 'Following text.',
        ]);
        expect(blocks.every(b => b.html === b.content)).toBe(true);
    });

    test('empty HTML body fails rather than sending a blank chapter', () => {
        expect(() => parseTextDocument('html',
            '<script>onlyScript()</script><style>body{display:none}</style>'))
            .toThrow(/no readable paragraphs/);
    });
});
