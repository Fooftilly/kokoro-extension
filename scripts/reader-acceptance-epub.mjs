/**
 * Shared Chromium EPUB 3 fixture for offline reader acceptance.
 * Keep labels and speech bodies aligned with reader_acceptance_epub.py.
 */
import JSZip from 'jszip';

export const READER_ACCEPTANCE_SPEECH = {
    'First Chapter': 'Hello first chapter.',
    'Second Chapter': 'Hello second chapter.',
    'acceptance.txt': 'Hello plain text.',
};

export async function buildReaderAcceptanceEpub() {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml',
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" ' +
        'media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/content.opf',
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" ' +
        'unique-identifier="book-id" xml:lang="en">' +
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<dc:identifier id="book-id">urn:uuid:01234567-89ab-4cde-8012-3456789abcde</dc:identifier>' +
        '<dc:title>Local Reader Acceptance</dc:title><dc:language>en</dc:language>' +
        '<meta property="dcterms:modified">2026-11-12T00:00:00Z</meta></metadata>' +
        '<manifest>' +
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
        '<item id="first" href="first.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="second" href="second.xhtml" media-type="application/xhtml+xml"/>' +
        '</manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>');
    zip.file('OEBPS/nav.xhtml',
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<html xmlns="http://www.w3.org/1999/xhtml" ' +
        'xmlns:epub="http://www.idpf.org/2007/ops"><head>' +
        '<title>Contents</title></head><body><nav epub:type="toc">' +
        '<ol><li><a href="first.xhtml">First Chapter</a></li>' +
        '<li><a href="second.xhtml">Second Chapter</a></li>' +
        '</ol></nav></body></html>');
    for (const [name, title] of [
        ['first', 'First Chapter'], ['second', 'Second Chapter'],
    ]) {
        const speech = READER_ACCEPTANCE_SPEECH[title];
        zip.file('OEBPS/' + name + '.xhtml',
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' +
            name + '</title></head><body><p id="' + name +
            '">' + speech + '</p></body></html>');
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
