/** @jest-environment jsdom */
import { TextDecoder } from 'util';
import JSZip from 'jszip';
import {
    MAX_DOCX_ARCHIVE_BYTES,
    MAX_DOCX_XML_BYTES,
    parseDocxDocument,
} from '../docx-reader.js';

global.TextDecoder = TextDecoder;
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const typesXml = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="' + MAIN_TYPE + '"/></Types>';
const docXml = body => '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="' + W + '"><w:body>' + body + '</w:body></w:document>';
async function docx(body, { contentTypes = typesXml, asXml = false } = {}) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypes);
    zip.file('word/document.xml', asXml ? body : docXml(body));
    return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

describe('bounded DOCX extraction through the packaged JSZip engine', () => {
    test('extracts ordinary prose and Word Heading styles in document order', async () => {
        const archive = await docx(
          '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Main title</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:hyperlink><w:r><w:t>reader</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>' +
          '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
          '<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Section heading</w:t></w:r></w:p>');
        expect(await parseDocxDocument(archive, JSZip)).toEqual([
            { type: 'h1', content: 'Main title', html: 'Main title', ids: [] },
            { type: 'text', content: 'Hello reader.', html: 'Hello reader.', ids: [] },
            { type: 'text', content: 'Cell one', html: 'Cell one', ids: [] },
            { type: 'text', content: 'Cell two', html: 'Cell two', ids: [] },
            { type: 'h2', content: 'Section heading', html: 'Section heading', ids: [] },
        ]);
    });

    test('does not speak deleted revisions, field instructions, or untrusted markup', async () => {
        const archive = await docx(
          '<w:p><w:r><w:t>New &amp; &lt;private&gt;</w:t></w:r>' +
          '<w:del><w:r><w:delText>removed secret</w:delText><w:t>old hidden words</w:t></w:r></w:del>' +
          '<w:moveFrom><w:r><w:t>moved out</w:t></w:r></w:moveFrom>' +
          '<w:r><w:instrText>HYPERLINK "https://external.invalid"</w:instrText></w:r>' +
          '<w:r><w:tab/><w:t>value</w:t><w:br/><w:t>next</w:t></w:r></w:p>');
        expect(await parseDocxDocument(archive, JSZip)).toEqual([
            { type: 'text', content: 'New & <private> value next',
                html: 'New &amp; &lt;private&gt; value next', ids: [] },
        ]);
    });

    test('skips entire moved-from and deleted paragraphs but reads the new destination', async () => {
        const archive = await docx(
            '<w:p><w:r><w:t>Before.</w:t></w:r></w:p>' +
            '<w:moveFrom><w:p><w:r><w:t>OLD moved paragraph.</w:t></w:r></w:p></w:moveFrom>' +
            '<w:del><w:p><w:r><w:t>OLD deleted paragraph.</w:t></w:r></w:p></w:del>' +
            '<w:moveTo><w:p><w:r><w:t>New destination.</w:t></w:r></w:p></w:moveTo>' +
            '<w:p><w:r><w:t>After.</w:t></w:r></w:p>');
        expect((await parseDocxDocument(archive, JSZip)).map(block => block.content))
            .toEqual(['Before.', 'New destination.', 'After.']);
    });

    test('speaks nested textbox paragraphs only once without merging them into the parent', async () => {
        const archive = await docx(
            '<w:p><w:r><w:t>Surrounding sentence.</w:t>' +
            '<w:drawing><w:txbxContent><w:p><w:r><w:t>Textbox text.</w:t></w:r></w:p></w:txbxContent></w:drawing>' +
            '<w:t> After textbox.</w:t></w:r></w:p>' +
            '<w:p><w:r><w:t>Normal following paragraph.</w:t></w:r></w:p>');
        expect((await parseDocxDocument(archive, JSZip)).map(block => block.content))
            .toEqual(['Surrounding sentence. After textbox.', 'Textbox text.',
                'Normal following paragraph.']);
    });

    test('does not fetch relationships or embedded media', async () => {
        const archive = new JSZip();
        archive.file('[Content_Types].xml', typesXml);
        archive.file('word/document.xml', docXml('<w:p><w:r><w:t>Safe text.</w:t></w:r></w:p>'));
        archive.file('word/_rels/document.xml.rels',
            '<Relationships><Relationship Target="https://external.invalid" TargetMode="External"/></Relationships>');
        archive.file('word/media/untrusted.svg', '<svg onload="alert(1)"/>');
        expect(await parseDocxDocument(await archive.generateAsync({ type: 'arraybuffer' }), JSZip))
            .toEqual([{ type: 'text', content: 'Safe text.', html: 'Safe text.', ids: [] }]);
    });

    test('rejects invalid ZIPs, renamed ZIPs, and missing Word document components', async () => {
        await expect(parseDocxDocument(new Uint8Array([1, 2, 3]).buffer, JSZip))
            .rejects.toThrow(/corrupt, encrypted/);
        const zip = new JSZip();
        zip.file('random.txt', 'Not a Word archive');
        await expect(parseDocxDocument(await zip.generateAsync({ type: 'arraybuffer' }), JSZip))
            .rejects.toThrow(/Not a valid Word DOCX/);
        const invalidTypes = await docx('<w:p><w:r><w:t>Text</w:t></w:r></w:p>', {
            contentTypes: '<Types/>',
        });
        await expect(parseDocxDocument(invalidTypes, JSZip))
            .rejects.toThrow(/Not a supported Word DOCX/);
    });

    test('rejects invalid XML, DTDs, wrong namespaces, and empty documents', async () => {
        const bad = await docx('<w:p><w:r><w:t>Broken</w:t></w:p>');
        await expect(parseDocxDocument(bad, JSZip)).rejects.toThrow(/malformed XML/);
        const dtd = await docx('<!DOCTYPE w:document [<!ENTITY huge "test">]><w:document xmlns:w="' + W + '"><w:body><w:p><w:r><w:t>Text</w:t></w:r></w:p></w:body></w:document>', { asXml: true });
        await expect(parseDocxDocument(dtd, JSZip)).rejects.toThrow(/not supported/);
        const wrongNs = await docx('<document><body><p><t>Text</t></p></body></document>', { asXml: true });
        await expect(parseDocxDocument(wrongNs, JSZip)).rejects.toThrow(/unexpected XML namespace/);
        await expect(parseDocxDocument(await docx('<w:p/>'), JSZip))
            .rejects.toThrow(/no readable paragraphs/);
    });

    test('caps compressed archive size and decompressed Word XML bytes', async () => {
        await expect(parseDocxDocument(new ArrayBuffer(MAX_DOCX_ARCHIVE_BYTES + 1), JSZip))
            .rejects.toThrow(/larger than 24 MiB/);
        const huge = await docx('<w:p><w:r><w:t>' +
            'X'.repeat(MAX_DOCX_XML_BYTES + 100) + '</w:t></w:r></w:p>');
        expect(huge.byteLength).toBeLessThan(MAX_DOCX_ARCHIVE_BYTES);
        await expect(parseDocxDocument(huge, JSZip)).rejects.toThrow(/safe size limit/);
    });

    test('rejects invalid decoder inputs and reports a missing packaged zip engine', async () => {
        await expect(parseDocxDocument(null, JSZip)).rejects.toThrow(/no readable binary data/);
        await expect(parseDocxDocument(new ArrayBuffer(1), null))
            .rejects.toThrow(/archive reader is unavailable/);
    });
});
