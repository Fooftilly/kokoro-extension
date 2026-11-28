/**
 * Shared Chromium EPUB 3 fixture for offline reader acceptance.
 * Keep labels and speech bodies aligned with reader_acceptance_epub.py.
 */
import JSZip from 'jszip';

export const READER_ACCEPTANCE_SPEECH = {
    'First Chapter': 'Hello first chapter.',
    'First Section': 'Hello first section.',
    'Second Chapter': 'Hello second chapter.',
    // First block text stays the chapter speech key; extra blocks enable
    // nonzero bookmark/resume seek coverage in the packaged acceptance stage.
    'Third Chapter': 'Hello third chapter.',
    'acceptance.txt': 'Hello plain text.',
};

/** Multi-block Third Chapter bodies (one <p> per block) for #196 seek tests. */
export const READER_ACCEPTANCE_THIRD_BLOCKS = Object.freeze([
    'Hello third chapter.',
    'Hello third chapter block two.',
    'Hello third chapter block three.',
]);

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
        '<item id="first-section" href="first-section.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="second" href="second.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="third" href="third.xhtml" media-type="application/xhtml+xml"/>' +
        '</manifest><spine>' +
        '<itemref idref="first"/><itemref idref="first-section"/>' +
        '<itemref idref="second"/><itemref idref="third"/>' +
        '</spine></package>');
    zip.file('OEBPS/nav.xhtml',
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<html xmlns="http://www.w3.org/1999/xhtml" ' +
        'xmlns:epub="http://www.idpf.org/2007/ops"><head>' +
        '<title>Contents</title></head><body><nav epub:type="toc">' +
        '<ol><li><a href="first.xhtml">First Chapter</a>' +
        '<ol><li><a href="first-section.xhtml">First Section</a></li></ol></li>' +
        '<li><a href="second.xhtml">Second Chapter</a></li>' +
        '<li><a href="third.xhtml">Third Chapter</a></li>' +
        '</ol></nav></body></html>');
    for (const [name, title] of [
        ['first', 'First Chapter'],
        ['first-section', 'First Section'],
        ['second', 'Second Chapter'],
        ['third', 'Third Chapter'],
    ]) {
        let body;
        if (title === 'Third Chapter') {
            body = READER_ACCEPTANCE_THIRD_BLOCKS.map((speech, index) => {
                const id = index === 0 ? name : (name + '-' + (index + 1));
                return '<p id="' + id + '">' + speech + '</p>';
            }).join('');
        } else {
            body = '<p id="' + name + '">' + READER_ACCEPTANCE_SPEECH[title] +
                '</p>';
        }
        zip.file('OEBPS/' + name + '.xhtml',
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' +
            name + '</title></head><body>' + body + '</body></html>');
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
