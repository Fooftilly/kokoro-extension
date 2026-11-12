"""Shared two-chapter EPUB 3 fixture for offline reader acceptance.

Keep labels, spine, and per-document speech bodies aligned with
scripts/validate-live-chromium.mjs so Chromium and Firefox exercise one
contract. No browser or Selenium imports.
"""
import zipfile

# Distinct dictionary-friendly English per document. Chromium harness must
# use the same map (see scripts/reader-acceptance-epub.mjs).
READER_ACCEPTANCE_SPEECH = {
    "First Chapter": "Hello first chapter.",
    "Second Chapter": "Hello second chapter.",
    "acceptance.txt": "Hello plain text.",
}


def build_reader_acceptance_epub(path):
    """Write a standards-structured two-chapter EPUB 3 archive to ``path``."""
    first_speech = READER_ACCEPTANCE_SPEECH["First Chapter"]
    second_speech = READER_ACCEPTANCE_SPEECH["Second Chapter"]
    with zipfile.ZipFile(path, "w") as archive:
        mimetype = zipfile.ZipInfo("mimetype")
        mimetype.compress_type = zipfile.ZIP_STORED
        archive.writestr(mimetype, "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" '
            'media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        archive.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
            'unique-identifier="book-id" xml:lang="en">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            '<dc:identifier id="book-id">urn:uuid:01234567-89ab-4cde-8012-3456789abcde</dc:identifier>'
            '<dc:title>Local Reader Acceptance</dc:title><dc:language>en</dc:language>'
            '<meta property="dcterms:modified">2026-11-12T00:00:00Z</meta></metadata>'
            '<manifest>'
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            '<item id="first" href="first.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="second" href="second.xhtml" media-type="application/xhtml+xml"/>'
            '</manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>',
        )
        archive.writestr(
            "OEBPS/nav.xhtml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<html xmlns="http://www.w3.org/1999/xhtml" '
            'xmlns:epub="http://www.idpf.org/2007/ops"><head>'
            '<title>Contents</title></head><body><nav epub:type="toc">'
            '<ol><li><a href="first.xhtml">First Chapter</a></li>'
            '<li><a href="second.xhtml">Second Chapter</a></li>'
            '</ol></nav></body></html>',
        )
        for name, speech in (("first", first_speech), ("second", second_speech)):
            archive.writestr(
                "OEBPS/" + name + ".xhtml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' +
                name + '</title></head><body><p id="' + name +
                '">' + speech + '</p></body></html>',
            )
