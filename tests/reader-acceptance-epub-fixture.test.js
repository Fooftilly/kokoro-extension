/** @jest-environment node */
/**
 * Contract for the in-memory EPUB 3 fixture used by Chromium and Firefox
 * offline reader acceptance (validate-live-chromium.mjs /
 * scripts/reader_acceptance_epub.py). Keep chapter labels and distinct
 * per-document speech bodies identical across both harnesses.
 */
const JSZip = require('jszip');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const READER_ACCEPTANCE_SPEECH = {
    'First Chapter': 'Hello first chapter.',
    'Second Chapter': 'Hello second chapter.',
    'acceptance.txt': 'Hello plain text.',
};

async function buildChromiumStyleEpub() {
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

describe('reader acceptance EPUB fixture contract', () => {
    test('Chromium-style fixture has distinct chapter speech and nav labels', async () => {
        const bytes = await buildChromiumStyleEpub();
        const zip = await JSZip.loadAsync(bytes);
        const fileNames = Object.keys(zip.files).filter(name => !zip.files[name].dir).sort();
        expect(fileNames).toEqual([
            'META-INF/container.xml',
            'OEBPS/content.opf',
            'OEBPS/first.xhtml',
            'OEBPS/nav.xhtml',
            'OEBPS/second.xhtml',
            'mimetype',
        ].sort());
        expect(await zip.file('mimetype').async('string')).toBe('application/epub+zip');
        expect(await zip.file('OEBPS/nav.xhtml').async('string'))
            .toContain('>First Chapter</a>');
        expect(await zip.file('OEBPS/nav.xhtml').async('string'))
            .toContain('>Second Chapter</a>');
        expect(await zip.file('OEBPS/first.xhtml').async('string'))
            .toContain(READER_ACCEPTANCE_SPEECH['First Chapter']);
        expect(await zip.file('OEBPS/second.xhtml').async('string'))
            .toContain(READER_ACCEPTANCE_SPEECH['Second Chapter']);
        expect(READER_ACCEPTANCE_SPEECH['First Chapter'])
            .not.toBe(READER_ACCEPTANCE_SPEECH['Second Chapter']);
        expect(READER_ACCEPTANCE_SPEECH['acceptance.txt'])
            .not.toBe(READER_ACCEPTANCE_SPEECH['First Chapter']);
    });

    test('Firefox harness builder emits the same structural contract', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-epub-fixture-'));
        const epubPath = path.join(tmp, 'offline-reader-acceptance.epub');
        const scriptsDir = path.join(__dirname, '..', 'scripts');
        const result = spawnSync('python3', ['-c', `
import json, sys, zipfile
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
from reader_acceptance_epub import (
    READER_ACCEPTANCE_SPEECH, build_reader_acceptance_epub)
build_reader_acceptance_epub(${JSON.stringify(epubPath)})
with zipfile.ZipFile(${JSON.stringify(epubPath)}) as z:
    print(json.dumps({
        'names': sorted(z.namelist()),
        'mime': z.read('mimetype').decode(),
        'mimeStored': z.getinfo('mimetype').compress_type == zipfile.ZIP_STORED,
        'nav': z.read('OEBPS/nav.xhtml').decode(),
        'first': z.read('OEBPS/first.xhtml').decode(),
        'second': z.read('OEBPS/second.xhtml').decode(),
        'speech': READER_ACCEPTANCE_SPEECH,
    }))
`], { encoding: 'utf8' });
        fs.rmSync(tmp, { recursive: true, force: true });
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const report = JSON.parse(result.stdout.trim());
        expect(report.mime).toBe('application/epub+zip');
        expect(report.mimeStored).toBe(true);
        expect(report.nav).toContain('>First Chapter</a>');
        expect(report.nav).toContain('>Second Chapter</a>');
        expect(report.speech).toEqual(READER_ACCEPTANCE_SPEECH);
        expect(report.first).toContain(READER_ACCEPTANCE_SPEECH['First Chapter']);
        expect(report.second).toContain(READER_ACCEPTANCE_SPEECH['Second Chapter']);
        expect(report.names).toEqual([
            'META-INF/container.xml',
            'OEBPS/content.opf',
            'OEBPS/first.xhtml',
            'OEBPS/nav.xhtml',
            'OEBPS/second.xhtml',
            'mimetype',
        ].sort());
    });
});
