"""Shared nested-TOC EPUB 3 fixture for offline reader acceptance.

Keep labels, spine, and per-document speech bodies aligned with
scripts/reader-acceptance-epub.mjs so Chromium and Firefox exercise one
contract. No browser or Selenium imports.
"""
import zipfile

# Distinct dictionary-friendly English per document. Chromium harness must
# use the same map (see scripts/reader-acceptance-epub.mjs).
READER_ACCEPTANCE_SPEECH = {
    "First Chapter": "Hello first chapter.",
    "First Section": "Hello first section.",
    "Second Chapter": "Hello second chapter.",
    # First block text stays the chapter speech key; extra blocks enable
    # nonzero bookmark/resume seek coverage in the packaged acceptance stage.
    "Third Chapter": "Hello third chapter.",
    "acceptance.txt": "Hello plain text.",
}

# Multi-block Third Chapter bodies (one <p> per block) for #196 seek tests.
READER_ACCEPTANCE_THIRD_BLOCKS = (
    "Hello third chapter.",
    "Hello third chapter block two.",
    "Hello third chapter block three.",
)


def build_reader_acceptance_epub(path):
    """Write a standards-structured nested-TOC EPUB 3 archive to ``path``."""
    first_speech = READER_ACCEPTANCE_SPEECH["First Chapter"]
    first_section_speech = READER_ACCEPTANCE_SPEECH["First Section"]
    second_speech = READER_ACCEPTANCE_SPEECH["Second Chapter"]
    third_speech = READER_ACCEPTANCE_SPEECH["Third Chapter"]
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
            '<item id="first-section" href="first-section.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="second" href="second.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="third" href="third.xhtml" media-type="application/xhtml+xml"/>'
            '</manifest><spine>'
            '<itemref idref="first"/><itemref idref="first-section"/>'
            '<itemref idref="second"/><itemref idref="third"/>'
            '</spine></package>',
        )
        archive.writestr(
            "OEBPS/nav.xhtml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<html xmlns="http://www.w3.org/1999/xhtml" '
            'xmlns:epub="http://www.idpf.org/2007/ops"><head>'
            '<title>Contents</title></head><body><nav epub:type="toc">'
            '<ol><li><a href="first.xhtml">First Chapter</a>'
            '<ol><li><a href="first-section.xhtml">First Section</a></li></ol></li>'
            '<li><a href="second.xhtml">Second Chapter</a></li>'
            '<li><a href="third.xhtml">Third Chapter</a></li>'
            '</ol></nav></body></html>',
        )
        for name, speech in (
            ("first", first_speech),
            ("first-section", first_section_speech),
            ("second", second_speech),
        ):
            archive.writestr(
                "OEBPS/" + name + ".xhtml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' +
                name + '</title></head><body><p id="' + name +
                '">' + speech + '</p></body></html>',
            )
        third_body = "".join(
            '<p id="' + ("third" if index == 0 else f"third-{index + 1}") +
            '">' + speech + "</p>"
            for index, speech in enumerate(READER_ACCEPTANCE_THIRD_BLOCKS)
        )
        archive.writestr(
            "OEBPS/third.xhtml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>third'
            '</title></head><body>' + third_body + '</body></html>',
        )
