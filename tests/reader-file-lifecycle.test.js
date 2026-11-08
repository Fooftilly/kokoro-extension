/** @jest-environment jsdom */
import { TextDecoder } from 'util';

global.TextDecoder = TextDecoder;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function documentWithText(text) {
    return new DOMParser().parseFromString('<html><body><p>' + text + '</p></body></html>', 'text/html');
}
function createMockBook(label, ready = Promise.resolve()) {
    const names = ['start.xhtml', 'next.xhtml'];
    const sections = names.map((href, index) => ({
        href, url: href, index,
        load: jest.fn(async () => documentWithText(label + ' ' + href)),
        unload: jest.fn(),
    }));
    return {
        ready,
        open: jest.fn(async () => {}),
        destroy: jest.fn(),
        navigation: { toc: names.map((href, i) => ({
            label: label + ' ' + (i + 1), href,
        })) },
        spine: {
            length: 2,
            get: jest.fn(id => typeof id === 'number'
                ? sections[id] : sections.find(s => s.href === id)),
        },
        load: jest.fn(),
        archive: { createUrl: jest.fn(async src => src), urlCache: {} },
        sections,
    };
}
function mountReaderDOM() {
    document.body.innerHTML = `
        <div id="filePickerOverlay" style="display:block"></div>
        <div id="dropZone"></div>
        <input id="fileInput" type="file">
        <div id="file-name-display"></div>
        <input id="scanDocumentHeadings" type="checkbox">
        <button id="openAnotherDocument" type="button"></button>
        <button id="cancelDocumentPicker" type="button" hidden></button>
        <div id="errorMsg" style="display:none"></div>
        <div id="chapterError" role="alert" hidden></div>
        <div id="loadingStatus" style="display:none"></div>
        <div id="chapterList"></div>
        <iframe id="playerFrame"></iframe>
        <div id="sidebar"></div>
        <div class="app-container"></div>
        <button id="prevChapter"></button>
        <button id="nextChapter"></button>
        <button id="toggleSidebar"></button>
        <button id="showSidebarBtn"></button>
    `;
}
describe('EPUB file read/parse lifecycle', () => {
    let readers;
    let books;
    let messages;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        mountReaderDOM();
        readers = [];
        books = [];
        messages = [];
        URL.revokeObjectURL = jest.fn();
        global.browser = {
            storage: {
                local: {
                    remove: jest.fn(async () => {}),
                    set: jest.fn(async () => {}),
                },
                sync: { get: jest.fn(async () => ({
                    ttsBackend: 'mediapipe',
                    mediaPipeVariant: 'cpu',
                    localVoice: 'af_heart',
                    autoplayReader: false,
                })) },
            },
        };
        global.FileReader = class {
            static LOADING = 1;
            constructor() {
                this.readyState = 0;
                readers.push(this);
            }
            readAsArrayBuffer(file) {
                this.file = file;
                this.readyState = 1;
            }
            abort() {
                this.readyState = 2;
                this.onabort?.();
            }
            succeed(buffer = new ArrayBuffer(8)) {
                this.result = buffer;
                this.readyState = 2;
                this.onload?.({ target: this });
            }
            fail(message) {
                this.error = new Error(message);
                this.readyState = 2;
                this.onerror?.();
            }
        };
        global.ePub = jest.fn(() => {
            const book = books.shift();
            if (!book) throw new Error('Missing test EPUB instance');
            return book;
        });
        document.getElementById('playerFrame').contentWindow.postMessage =
            jest.fn(value => messages.push(value));
        require('../reader.js');
    });

    function acknowledgeCurrentChapter({ revision, source } = {}) {
        const writes = browser.storage.local.set.mock.calls;
        const latestRevision = writes[writes.length - 1]?.[0]?.pendingReaderReloadRevision;
        expect(Number.isSafeInteger(latestRevision)).toBe(true);
        const frame = document.getElementById('playerFrame');
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'KOKORO_READER_RELOAD_READY',
                revision: revision ?? latestRevision,
            },
            source: source === undefined ? frame.contentWindow : source,
        }));
    }

    async function expectPlainDocument(filename, expectedText) {
        for (let i = 0; i < 30 &&
            (!browser.storage.local.set.mock.calls.some(([value]) => value.pendingTitle === filename) ||
                document.getElementById('filePickerOverlay').style.display !== 'none');
            i++) await tick();
        expect(document.getElementById('filePickerOverlay').style.display).toBe('none');
        expect(document.getElementById('loadingStatus').style.display).toBe('none');
        expect(document.querySelectorAll('.chapter-item')).toHaveLength(1);
        expect(document.querySelector('.chapter-label').textContent).toBe(filename);
        const stored = browser.storage.local.set.mock.calls
            .map(([value]) => value)
            .find(value => value.pendingTitle === filename);
        expect(stored.pendingContent.map(block => block.content).join(' '))
            .toContain(expectedText);
        expect(messages).toContain('RELOAD_DATA');
        return stored;
    }

    function selectFile(name, type = 'application/epub+zip') {
        const input = document.getElementById('fileInput');
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [{ name, type }],
        });
        input.dispatchEvent(new Event('change'));
        return readers[readers.length - 1];
    }

    async function expectLoaded(label) {
        for (let n = 0; n < 30 && messages.length === 0; n++) await tick();
        expect(document.getElementById('filePickerOverlay').style.display).toBe('none');
        expect(document.getElementById('loadingStatus').style.display).toBe('none');
        expect(document.querySelectorAll('.chapter-item')).toHaveLength(2);
        expect(browser.storage.local.set).toHaveBeenCalledWith(
            expect.objectContaining({ pendingTitle: label + ' 1' }));
        expect(messages).toContain('RELOAD_DATA');
    }

    test('reads TXT into one reader chapter with escaped markup and intact local backend settings', async () => {
        const { TextEncoder } = require('util');
        const bytes = new TextEncoder().encode('Hello <world> & friends.\n\nSecond paragraph.');
        selectFile('notes.txt', 'text/plain').succeed(bytes.buffer);
        const stored = await expectPlainDocument('notes.txt', 'Hello <world> & friends.');
        expect(ePub).not.toHaveBeenCalled();
        expect(stored.pendingContent).toHaveLength(2);
        expect(stored.pendingContent[0].html).toContain('&lt;world&gt;');
        expect(stored.pendingTtsBackend).toBe('mediapipe');
        expect(stored.pendingMediaPipeVariant).toBe('cpu');
    });

    test('reads Markdown headings and words without treating markup as active HTML', async () => {
        const { TextEncoder } = require('util');
        selectFile('README.md', 'text/markdown').succeed(
            new TextEncoder().encode('# Main heading\n\n**Bold** and [docs](https://example.org).').buffer);
        const stored = await expectPlainDocument('README.md', 'Main heading');
        expect(stored.pendingContent.map(entry => entry.type)).toEqual(['h1', 'text']);
        expect(stored.pendingContent[1].content).toBe('Bold and docs.');
        expect(stored.pendingContent[1].html).not.toContain('https://example.org');
    });

    test('reads HTML paragraphs without importing scripts, links, or external markup', async () => {
        const { TextEncoder } = require('util');
        const markup = '<h2>A chapter</h2><p>Hello <b>reader</b>.</p>' +
            '<script>fetch("https://example.org/secrets")</script>' +
            '<p onclick="bad()">Last &amp; final.</p>';
        selectFile('book.html', 'text/html').succeed(
            new TextEncoder().encode(markup).buffer);
        const stored = await expectPlainDocument('book.html', 'Hello reader.');
        expect(stored.pendingContent.map(entry => entry.type)).toEqual(['h2', 'text', 'text']);
        expect(JSON.stringify(stored.pendingContent)).not.toContain('https://example.org');
        expect(JSON.stringify(stored.pendingContent)).not.toContain('onclick');
    });

    test('supports UTF-16-BOM plain text and reports binary files without closing picker', async () => {
        selectFile('unicode.text', 'text/plain').succeed(
            Uint8Array.from([0xff, 0xfe, 72, 0, 105, 0]).buffer);
        await expectPlainDocument('unicode.text', 'Hi');

        selectFile('garbled.txt', 'text/plain').succeed(
            Uint8Array.from([65, 0, 66]).buffer);
        await tick();
        expect(document.getElementById('filePickerOverlay').style.display).toBe('none');
        // The user must explicitly reopen the picker to replace a document;
        // a failed replacement never silently erases the working chapter.
        expect(document.getElementById('errorMsg').style.display).toBe('block');
        expect(document.getElementById('errorMsg').textContent).toContain('binary');
        expect(browser.storage.local.set.mock.calls.map(([value]) => value.pendingTitle))
            .toEqual(['unicode.text']);
    });

    test('rejects unknown document extensions before reading bytes', async () => {
        selectFile('notes.pdf', 'application/pdf');
        await tick();
        expect(document.getElementById('filePickerOverlay').style.display).toBe('block');
        expect(document.getElementById('errorMsg').textContent).toContain('Unsupported format');
        expect(document.getElementById('errorMsg').style.display).toBe('block');
        expect(ePub).not.toHaveBeenCalled();
        expect(readers).toHaveLength(0);
    });

    test('stale text-file reads are aborted and cannot supersede a newer EPUB', async () => {
        const bookA = createMockBook('Book B');
        books.push(bookA);
        const oldReader = selectFile('older.md', 'text/markdown');
        const currentReader = selectFile('newer.epub', 'application/epub+zip');
        expect(oldReader.readyState).toBe(2);
        currentReader.succeed();
        await expectLoaded('Book B');
        expect(browser.storage.local.set.mock.calls.map(([value]) => value.pendingTitle))
            .toEqual(['Book B 1']);
        expect(document.getElementById('file-name-display').textContent).toBe('newer.epub');
    });

    test('switching from EPUB to TXT retains old archive until player acknowledges new text', async () => {
        const bookA = createMockBook('Book A');
        books.push(bookA);
        selectFile('old.epub').succeed();
        await expectLoaded('Book A');
        messages.length = 0;

        const { TextEncoder } = require('util');
        selectFile('new.txt', 'text/plain').succeed(
            new TextEncoder().encode('Fresh new document.').buffer);
        await expectPlainDocument('new.txt', 'Fresh new document.');
        expect(bookA.destroy).not.toHaveBeenCalled();
        acknowledgeCurrentChapter();
        for (let i = 0; i < 30 && bookA.destroy.mock.calls.length === 0; i++) await tick();
        expect(bookA.destroy).toHaveBeenCalledTimes(1);
        expect(ePub).toHaveBeenCalledTimes(1);
    });

    test('Open another and Cancel preserve active book, chapter and player', async () => {
        books.push(createMockBook('Book A'));
        selectFile('book-a.epub').succeed();
        await expectLoaded('Book A');
        const written = browser.storage.local.set.mock.calls.length;
        const sent = messages.length;

        document.getElementById('openAnotherDocument').click();
        expect(document.getElementById('filePickerOverlay').style.display).toBe('flex');
        expect(document.getElementById('cancelDocumentPicker').hidden).toBe(false);
        expect(document.getElementById('file-name-display').textContent).toBe('No file selected.');
        document.getElementById('cancelDocumentPicker').click();

        expect(document.getElementById('filePickerOverlay').style.display).toBe('none');
        expect(document.querySelector('.chapter-label').textContent).toBe('Book A 1');
        expect(browser.storage.local.set).toHaveBeenCalledTimes(written);
        expect(messages).toHaveLength(sent);
    });

    test('cancel while a replacement file is reading aborts it and keeps the active document', async () => {
        books.push(createMockBook('Book A'));
        selectFile('a.epub').succeed();
        await expectLoaded('Book A');
        document.getElementById('openAnotherDocument').click();
        const pending = selectFile('replacement.epub');
        expect(pending.readyState).toBe(FileReader.LOADING);
        document.getElementById('cancelDocumentPicker').click();
        expect(pending.readyState).toBe(2);
        await tick();
        expect(document.getElementById('filePickerOverlay').style.display).toBe('none');
        expect(document.querySelector('.chapter-label').textContent).toBe('Book A 1');
        expect(document.getElementById('errorMsg').style.display).toBe('none');
        expect(ePub).toHaveBeenCalledTimes(1);
    });

    test('cancel during EPUB open leaves active book unchanged and destroys old candidate', async () => {
        const candidateOpened = deferred();
        const existing = createMockBook('Book A');
        const candidate = createMockBook('Cancelled');
        candidate.open.mockImplementationOnce(() => candidateOpened.promise);
        books.push(existing, candidate);
        selectFile('a.epub').succeed();
        await expectLoaded('Book A');
        document.getElementById('openAnotherDocument').click();
        selectFile('replacement.epub').succeed();
        for (let i = 0; i < 30 && candidate.open.mock.calls.length === 0; i++) await tick();
        expect(candidate.open).toHaveBeenCalledTimes(1);
        document.getElementById('cancelDocumentPicker').click();
        candidateOpened.resolve();
        await tick();
        await tick();
        expect(candidate.destroy).toHaveBeenCalledTimes(1);
        expect(existing.destroy).not.toHaveBeenCalled();
        expect(document.querySelector('.chapter-label').textContent).toBe('Book A 1');
        expect(document.getElementById('filePickerOverlay').style.display).toBe('none');
    });

    test('a committed text replacement closes Cancel even while player storage is pending', async () => {
        const existing = createMockBook('Book A');
        books.push(existing);
        selectFile('old.epub').succeed();
        await expectLoaded('Book A');

        const stalledWrite = deferred();
        browser.storage.local.set.mockImplementationOnce(() => stalledWrite.promise);
        document.getElementById('openAnotherDocument').click();
        const bytes = new (require('util').TextEncoder)().encode('The next document is ready.');
        selectFile('new.txt', 'text/plain').succeed(bytes.buffer);
        for (let i = 0; i < 30 &&
            document.getElementById('filePickerOverlay').style.display !== 'none'; i++) await tick();

        // The file has committed; the old archive remains until iframe ACK.
        expect(document.getElementById('filePickerOverlay').style.display).toBe('none');
        expect(document.querySelector('.chapter-label').textContent).toBe('new.txt');
        expect(existing.destroy).not.toHaveBeenCalled();
        document.getElementById('cancelDocumentPicker').click();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.querySelector('.chapter-label').textContent).toBe('new.txt');

        stalledWrite.resolve();
        for (let i = 0; i < 30 &&
            !browser.storage.local.set.mock.calls.some(([value]) => value.pendingTitle === 'new.txt');
            i++) await tick();
        await tick();
        expect(browser.storage.local.set.mock.lastCall[0].pendingTitle).toBe('new.txt');
        expect(messages.at(-1)).toBe('RELOAD_DATA');
    });

    test('text playback storage failure is visible after picker closes', async () => {
        browser.storage.local.set.mockRejectedValueOnce(new Error('Storage quota exceeded'));
        const bytes = new (require('util').TextEncoder)().encode('Readable text.');
        selectFile('text.txt', 'text/plain').succeed(bytes.buffer);
        for (let i = 0; i < 30 &&
            document.getElementById('chapterError').hidden; i++) await tick();
        expect(document.getElementById('filePickerOverlay').style.display).toBe('none');
        expect(document.getElementById('chapterError').textContent)
            .toContain('Storage quota exceeded');
        expect(document.getElementById('chapterError').hidden).toBe(false);
    });

    test('publisher TOC stays authoritative until heading scan is explicitly selected', async () => {
        const publisher = createMockBook('Publisher');
        const heading = createMockBook('Publisher');
        const headingDoc = (title) => new DOMParser().parseFromString(
            '<html><body><h1 id="heading">' + title + '</h1><p>Body text.</p></body></html>',
            'text/html');
        publisher.sections[0].load.mockImplementation(async () => headingDoc('Scanned Title A'));
        heading.sections[0].load.mockImplementation(async () => headingDoc('Scanned Title A'));
        heading.sections[1].load.mockImplementation(async () => headingDoc('Scanned Title B'));
        books.push(publisher, heading);
        selectFile('default.epub').succeed();
        await expectLoaded('Publisher');
        expect(Array.from(document.querySelectorAll('.chapter-label'), node => node.textContent))
            .toEqual(['Publisher 1', 'Publisher 2']);
        expect(publisher.sections[0].load).toHaveBeenCalledTimes(1);
        expect(publisher.sections[1].load).not.toHaveBeenCalled();

        document.getElementById('openAnotherDocument').click();
        document.getElementById('scanDocumentHeadings').checked = true;
        selectFile('scanned.epub').succeed();
        for (let i = 0; i < 30 &&
            document.querySelector('.chapter-label')?.textContent !== 'Scanned Title A'; i++) await tick();
        expect(Array.from(document.querySelectorAll('.chapter-label'), node => node.textContent))
            .toEqual(['Scanned Title A', 'Scanned Title B']);
        expect(heading.sections[1].load).toHaveBeenCalledTimes(1);
    });

    test('publisher navigation hrefs resolve relative to nav.xhtml while preserving order and fragments', async () => {
        const candidate = createMockBook('Publisher');
        candidate.packaging = { navPath: 'Nav/nav.xhtml' };
        candidate.sections[0].href = 'Text/ch1.xhtml';
        candidate.sections[0].url = 'Text/ch1.xhtml';
        candidate.sections[1].href = 'Text/ch2.xhtml';
        candidate.sections[1].url = 'Text/ch2.xhtml';
        candidate.sections[0].load.mockResolvedValue(
            new DOMParser().parseFromString('<p id="intro">First chapter text.</p>', 'text/html'));
        candidate.navigation.toc = [
            { href: '../Text/ch1.xhtml#intro', label: 'Chapter One' },
            { href: '../Text/ch2.xhtml', label: 'Chapter Two' },
        ];
        books.push(candidate);
        selectFile('nested-nav.epub').succeed();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length === 0; i++) await tick();

        expect(Array.from(document.querySelectorAll('.playable-chapter'), el => el.dataset.href))
            .toEqual(['Text/ch1.xhtml#intro', 'Text/ch2.xhtml']);
        expect(browser.storage.local.set.mock.lastCall[0].pendingTitle).toBe('Chapter One');
        expect(browser.storage.local.set.mock.lastCall[0].pendingContent.map(b => b.content))
            .toContain('First chapter text.');
        expect(candidate.sections[0].load).toHaveBeenCalledTimes(1);
        expect(candidate.sections[1].load).not.toHaveBeenCalled();
        expect(document.getElementById('chapterError').hidden).toBe(true);

        document.getElementById('nextChapter').click();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length < 2; i++) await tick();
        expect(browser.storage.local.set.mock.lastCall[0].pendingTitle).toBe('Chapter Two');
    });

    test('navigation-relative link wins when an identical root-level filename also exists', async () => {
        const candidate = createMockBook('Publisher');
        candidate.packaging = { navPath: 'Nav/nav.xhtml' };
        candidate.sections[0].href = 'chapter.xhtml';
        candidate.sections[0].url = 'chapter.xhtml';
        candidate.sections[1].href = 'Nav/chapter.xhtml';
        candidate.sections[1].url = 'Nav/chapter.xhtml';
        candidate.sections[0].load.mockResolvedValue(documentWithText('Wrong root-level chapter.'));
        candidate.sections[1].load.mockResolvedValue(documentWithText('Correct navigation chapter.'));
        candidate.navigation.toc = [{ href: 'chapter.xhtml', label: 'Navigation chapter' }];
        books.push(candidate);
        selectFile('colliding-names.epub').succeed();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length === 0; i++) await tick();

        expect(document.querySelector('.playable-chapter').dataset.href)
            .toBe('Nav/chapter.xhtml');
        expect(candidate.sections[0].load).not.toHaveBeenCalled();
        expect(candidate.sections[1].load).toHaveBeenCalledTimes(1);
        expect(browser.storage.local.set.mock.lastCall[0].pendingContent[0].content)
            .toContain('Correct navigation chapter.');
    });

    test('fragment-only TOC link plays the navigation document when it belongs to the spine', async () => {
        const candidate = createMockBook('Publisher');
        candidate.packaging = { navPath: 'Nav/nav.xhtml' };
        candidate.sections[0].href = 'Nav/nav.xhtml';
        candidate.sections[0].url = 'Nav/nav.xhtml';
        candidate.sections[0].load.mockResolvedValue(
            new DOMParser().parseFromString(
                '<body><h1 id="chapter1">Chapter in navigation document</h1></body>',
                'text/html'));
        candidate.navigation.toc = [{ href: '#chapter1', label: 'Navigation chapter' }];
        books.push(candidate);
        selectFile('fragment-nav.epub').succeed();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length === 0; i++) await tick();

        expect(document.querySelector('.playable-chapter').dataset.href)
            .toBe('Nav/nav.xhtml#chapter1');
        expect(browser.storage.local.set.mock.lastCall[0].pendingTitle)
            .toBe('Navigation chapter');
        expect(browser.storage.local.set.mock.lastCall[0].pendingStartIndex).toBe(0);
        expect(document.getElementById('chapterError').hidden).toBe(true);
    });

    test('heading-scanned paths are not redirected by a same-name navigation-relative chapter', async () => {
        const candidate = createMockBook('Publisher');
        candidate.packaging = { navPath: 'Nav/nav.xhtml' };
        candidate.sections[0].href = 'chapter.xhtml';
        candidate.sections[0].url = 'chapter.xhtml';
        candidate.sections[1].href = 'Nav/chapter.xhtml';
        candidate.sections[1].url = 'Nav/chapter.xhtml';
        candidate.sections[0].load.mockResolvedValue(new DOMParser().parseFromString(
            '<body><h1 id="root">The root chapter.</h1></body>', 'text/html'));
        candidate.sections[1].load.mockResolvedValue(new DOMParser().parseFromString(
            '<body><h1 id="nav">The navigation chapter.</h1></body>', 'text/html'));
        candidate.navigation.toc = [{ href: 'chapter.xhtml', label: 'Publisher item' }];
        document.getElementById('scanDocumentHeadings').checked = true;
        books.push(candidate);
        selectFile('scan-collision.epub').succeed();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length === 0; i++) await tick();

        expect(Array.from(document.querySelectorAll('.playable-chapter'), el => el.dataset.href))
            .toEqual(['chapter.xhtml#root', 'Nav/chapter.xhtml#nav']);
        expect(browser.storage.local.set.mock.lastCall[0].pendingTitle)
            .toBe('The root chapter.');
        expect(browser.storage.local.set.mock.lastCall[0].pendingContent[0].content)
            .toBe('The root chapter.');
        expect(document.getElementById('chapterError').hidden).toBe(true);
    });

    test('heading scan without discovered headings still resolves publisher navigation-relative paths', async () => {
        const candidate = createMockBook('Publisher');
        candidate.packaging = { navPath: 'Nav/nav.xhtml' };
        candidate.sections[0].href = 'Text/ch1.xhtml';
        candidate.sections[0].url = 'Text/ch1.xhtml';
        candidate.sections[1].href = 'Text/ch2.xhtml';
        candidate.sections[1].url = 'Text/ch2.xhtml';
        candidate.navigation.toc = [
            { href: '../Text/ch1.xhtml', label: 'Original chapter one' },
            { href: '../Text/ch2.xhtml', label: 'Original chapter two' },
        ];
        document.getElementById('scanDocumentHeadings').checked = true;
        books.push(candidate);
        selectFile('no-headings.epub').succeed();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length === 0; i++) await tick();

        expect(Array.from(document.querySelectorAll('.playable-chapter'), el => el.dataset.href))
            .toEqual(['Text/ch1.xhtml', 'Text/ch2.xhtml']);
        expect(browser.storage.local.set.mock.lastCall[0].pendingTitle)
            .toBe('Original chapter one');
        expect(candidate.sections[1].load).toHaveBeenCalledTimes(1); // heading scan only
        expect(candidate.sections[0].load).toHaveBeenCalledTimes(2); // scan + speech
    });

    test('non-linked publisher TOC groups are preserved but skipped by playback and Prev/Next', async () => {
        const candidate = createMockBook('Publisher');
        candidate.navigation.toc = [
            { href: '', label: 'Part One', subitems: [
                { href: 'start.xhtml', label: 'First linked chapter' },
                { href: 'next.xhtml', label: 'Second linked chapter' },
            ] },
            { href: '', label: 'Acknowledgments group', subitems: [] },
        ];
        books.push(candidate);
        selectFile('grouped.epub').succeed();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length === 0; i++) await tick();

        expect(Array.from(document.querySelectorAll('.chapter-label'), el => el.textContent))
            .toEqual(['Part One', 'First linked chapter', 'Second linked chapter', 'Acknowledgments group']);
        expect(document.querySelectorAll('.playable-chapter')).toHaveLength(2);
        expect(document.querySelector('.playable-chapter.active .chapter-label').textContent)
            .toBe('First linked chapter');
        expect(document.querySelector('.chapter-group').classList.contains('expanded')).toBe(true);
        expect(document.getElementById('prevChapter').disabled).toBe(true);
        expect(document.getElementById('nextChapter').disabled).toBe(false);
        expect(browser.storage.local.set.mock.lastCall[0].pendingTitle).toBe('First linked chapter');

        const writesBefore = browser.storage.local.set.mock.calls.length;
        document.querySelector('.chapter-group-label').click();
        await tick();
        expect(browser.storage.local.set).toHaveBeenCalledTimes(writesBefore);

        document.getElementById('nextChapter').click();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length < 2; i++) await tick();
        expect(browser.storage.local.set.mock.lastCall[0].pendingTitle).toBe('Second linked chapter');
        expect(document.getElementById('nextChapter').disabled).toBe(true);
    });

    test('percent-encoded publisher anchor selects the Unicode DOM ID rather than the first block', async () => {
        const candidate = createMockBook('Book A');
        candidate.navigation.toc[0].href = 'start.xhtml#caf%C3%A9';
        candidate.sections[0].load.mockResolvedValue(
            new DOMParser().parseFromString(
                '<body><p>Prelude sentence.</p><h2 id="café">Café chapter.</h2></body>',
                'text/html'));
        books.push(candidate);
        selectFile('encoded-anchor.epub').succeed();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length === 0; i++) await tick();
        expect(browser.storage.local.set.mock.lastCall[0].pendingStartIndex).toBe(1);
        expect(document.getElementById('chapterError').hidden).toBe(true);
    });

    test('playback progress matches encoded publisher anchors and updates the reader title', async () => {
        const candidate = createMockBook('Book A');
        candidate.navigation.toc = [
            { href: 'start.xhtml', label: 'Chapter beginning' },
            { href: 'start.xhtml#caf%C3%A9', label: 'Café subsection' },
        ];
        candidate.sections[0].load.mockResolvedValue(
            new DOMParser().parseFromString(
                '<body><p>Prelude sentence.</p><h2 id="café">Café chapter.</h2></body>',
                'text/html'));
        books.push(candidate);
        selectFile('encoded-progress.epub').succeed();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length === 0; i++) await tick();
        expect(document.querySelector('.playable-chapter.active').dataset.href).toBe('start.xhtml');
        const next = document.querySelector('[data-href="start.xhtml#caf%C3%A9"]');
        next.scrollIntoView = jest.fn();

        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'KOKORO_READING_PROGRESS', blockIndex: 1 },
        }));

        expect(document.querySelector('.playable-chapter.active')).toBe(next);
        expect(document.getElementById('prevChapter').disabled).toBe(false);
        expect(document.getElementById('nextChapter').disabled).toBe(true);
        expect(messages).toContainEqual({ type: 'UPDATE_TITLE', title: 'Café subsection' });
        expect(next.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    test('malformed publisher fragments cannot block progress matching later valid anchors', async () => {
        const candidate = createMockBook('Book A');
        candidate.navigation.toc = [
            { href: 'start.xhtml', label: 'Chapter beginning' },
            { href: 'start.xhtml#bad%ZZ', label: 'Malformed anchor' },
            { href: 'start.xhtml#caf%C3%A9', label: 'Correct anchor' },
        ];
        candidate.sections[0].load.mockResolvedValue(
            new DOMParser().parseFromString(
                '<body><p>Prelude sentence.</p><h2 id="café">Café chapter.</h2></body>',
                'text/html'));
        books.push(candidate);
        selectFile('malformed-progress.epub').succeed();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length === 0; i++) await tick();
        const validItem = document.querySelector('[data-href="start.xhtml#caf%C3%A9"]');
        validItem.scrollIntoView = jest.fn();

        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'KOKORO_READING_PROGRESS', blockIndex: 1 },
        }));

        expect(document.querySelector('.playable-chapter.active')).toBe(validItem);
        expect(messages).toContainEqual({ type: 'UPDATE_TITLE', title: 'Correct anchor' });
        expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
    });

    test('malformed publisher anchor escapes warn and fall back without aborting playback', async () => {
        const candidate = createMockBook('Book A');
        candidate.navigation.toc[0].href = 'start.xhtml#bad%ZZ';
        books.push(candidate);
        selectFile('malformed-anchor.epub').succeed();
        for (let i = 0; i < 30 && browser.storage.local.set.mock.calls.length === 0; i++) await tick();
        expect(browser.storage.local.set.mock.lastCall[0].pendingStartIndex).toBe(0);
        expect(document.getElementById('chapterError').hidden).toBe(false);
        expect(document.getElementById('chapterError').textContent)
            .toContain('requested chapter anchor could not be found');
        expect(document.getElementById('filePickerOverlay').style.display).toBe('none');
    });

    test('missing EPUB TOC anchor warns visibly and falls back to chapter start', async () => {
        const candidate = createMockBook('Book A');
        candidate.navigation.toc[0].href = 'start.xhtml#absent';
        books.push(candidate);
        selectFile('book-a.epub').succeed();
        await expectLoaded('Book A');
        expect(document.getElementById('chapterError').hidden).toBe(false);
        expect(document.getElementById('chapterError').textContent)
            .toContain('requested chapter anchor could not be found');
        const lastWrite = browser.storage.local.set.mock.lastCall[0];
        expect(lastWrite.pendingStartIndex).toBe(0);
        document.getElementById('nextChapter').click();
        expect(document.getElementById('chapterError').hidden).toBe(true);
    });

    test('does not dismiss picker until both file read and EPUB ready/TOC scan finish', async () => {
        const ready = deferred();
        books.push(createMockBook('Book A', ready.promise));
        const reader = selectFile('book-a.epub');
        expect(reader.readyState).toBe(FileReader.LOADING);
        expect(document.getElementById('loadingStatus').style.display).toBe('block');
        expect(document.getElementById('filePickerOverlay').style.display).toBe('block');
        expect(ePub).not.toHaveBeenCalled();

        reader.succeed();
        await tick();
        expect(ePub).toHaveBeenCalledTimes(1);
        expect(document.getElementById('filePickerOverlay').style.display).toBe('block');

        ready.resolve();
        await expectLoaded('Book A');
        expect(document.getElementById('errorMsg').style.display).toBe('none');
    });

    test('read errors are shown to the user without dismissing the picker', async () => {
        const reader = selectFile('bad.epub');
        reader.fail('Disk read failure');
        await tick();
        expect(document.getElementById('filePickerOverlay').style.display).toBe('block');
        expect(document.getElementById('loadingStatus').style.display).toBe('none');
        expect(document.getElementById('errorMsg').textContent).toContain('Disk read failure');
        expect(document.getElementById('errorMsg').style.display).toBe('block');
        expect(ePub).not.toHaveBeenCalled();
        expect(messages).toEqual([]);
    });

    test('invalid EPUB open() failure propagates even when ready never settles', async () => {
        const neverReady = deferred();
        const badBook = createMockBook('Invalid', neverReady.promise);
        badBook.open.mockRejectedValueOnce(new Error('Invalid ZIP or missing container'));
        books.push(badBook);
        const reader = selectFile('corrupt.epub');
        reader.succeed();
        await tick();
        await tick();
        expect(ePub).toHaveBeenCalledWith();
        expect(badBook.open).toHaveBeenCalledWith(expect.any(ArrayBuffer));
        expect(document.getElementById('filePickerOverlay').style.display).toBe('block');
        expect(document.getElementById('errorMsg').textContent)
            .toContain('Invalid ZIP or missing container');
        expect(document.getElementById('loadingStatus').style.display).toBe('none');
        expect(document.querySelectorAll('.chapter-item')).toHaveLength(0);
    });

    test('rejection of ready after successful open also reports the failure', async () => {
        const failed = deferred();
        const badBook = createMockBook('Invalid', failed.promise);
        books.push(badBook);
        const reader = selectFile('corrupt.epub');
        reader.succeed();
        await tick();
        expect(badBook.open).toHaveBeenCalledTimes(1);
        failed.reject(new Error('Invalid EPUB metadata'));
        await tick();
        expect(document.getElementById('filePickerOverlay').style.display).toBe('block');
        expect(document.getElementById('errorMsg').textContent)
            .toContain('Invalid EPUB metadata');
        expect(document.getElementById('loadingStatus').style.display).toBe('none');
        expect(document.querySelectorAll('.chapter-item')).toHaveLength(0);
    });

    test('new selection aborts an older pending read without displaying its error', async () => {
        books.push(createMockBook('Book B'));
        const first = selectFile('old.epub');
        const second = selectFile('new.epub');
        expect(first.readyState).toBe(2);
        expect(second.readyState).toBe(1);
        second.succeed();
        await expectLoaded('Book B');
        expect(ePub).toHaveBeenCalledTimes(1);
        expect(document.getElementById('file-name-display').textContent).toBe('new.epub');
        expect(document.getElementById('errorMsg').style.display).toBe('none');
    });

    test('old book readiness cannot replace newer successful book', async () => {
        const oldReady = deferred();
        books.push(createMockBook('Book A', oldReady.promise), createMockBook('Book B'));
        const oldReader = selectFile('a.epub');
        oldReader.succeed();
        await tick(); // A is now waiting for EPUB ready.
        const newReader = selectFile('b.epub');
        newReader.succeed();
        await expectLoaded('Book B');

        oldReady.resolve();
        await tick();
        await tick();
        expect(document.querySelector('.chapter-label').textContent).toBe('Book B 1');
        expect(browser.storage.local.set.mock.calls.every(([value]) =>
            value.pendingTitle.startsWith('Book B'))).toBe(true);
        expect(document.getElementById('file-name-display').textContent).toBe('b.epub');
        expect(messages).toEqual(['RELOAD_DATA']);
    });

    test('opt-in scanning unloads all scanned spine documents and played chapter DOMs', async () => {
        const a = createMockBook('Book A');
        document.getElementById('scanDocumentHeadings').checked = true;
        books.push(a);
        selectFile('book.epub').succeed();
        await expectLoaded('Book A');
        // TOC scans both sections, then the automatically selected first
        // chapter reloads section 0 for its content. Neither DOM is retained.
        expect(a.sections[0].load).toHaveBeenCalledTimes(2);
        expect(a.sections[1].load).toHaveBeenCalledTimes(1);
        expect(a.sections[0].unload).toHaveBeenCalledTimes(2);
        expect(a.sections[1].unload).toHaveBeenCalledTimes(1);
        expect(a.destroy).not.toHaveBeenCalled();
    });

    test('old archive is destroyed only after replacement chapter reaches player', async () => {
        const a = createMockBook('Book A');
        const b = createMockBook('Book B');
        const nextReady = deferred();
        b.sections[0].load.mockImplementationOnce(() => nextReady.promise);
        books.push(a, b);
        selectFile('book-a.epub').succeed();
        await expectLoaded('Book A');
        messages.length = 0;
        selectFile('book-b.epub').succeed();
        // New B book/TOC commits, but its first chapter is still loading.
        for (let n = 0; n < 30 && document.querySelector('.chapter-label')?.textContent !== 'Book B 1'; n++) {
            await tick();
        }
        expect(document.querySelector('.chapter-label').textContent).toBe('Book B 1');
        expect(a.destroy).not.toHaveBeenCalled();
        nextReady.resolve(documentWithText('First B chapter'));
        for (let n = 0; n < 30 && messages.length === 0; n++) await tick();
        expect(messages).toEqual(['RELOAD_DATA']);
        // Merely posting RELOAD_DATA is not proof the iframe is finished.
        expect(a.destroy).not.toHaveBeenCalled();
        acknowledgeCurrentChapter();
        for (let n = 0; n < 30 && a.destroy.mock.calls.length === 0; n++) await tick();
        expect(a.destroy).toHaveBeenCalledTimes(1);
        expect(b.destroy).not.toHaveBeenCalled();
    });

    test('abandoned and failed EPUB candidates release their archives', async () => {
        const firstOpen = deferred();
        const abandoned = createMockBook('Abandoned');
        abandoned.open.mockImplementation(() => firstOpen.promise);
        const current = createMockBook('Current');
        const broken = createMockBook('Broken');
        broken.open.mockRejectedValue(new Error('Corrupt archive'));
        books.push(abandoned, current, broken);

        selectFile('abandoned.epub').succeed();
        await tick(); // its open() has begun
        selectFile('current.epub').succeed();
        await expectLoaded('Current');
        firstOpen.resolve();
        await tick();
        expect(abandoned.destroy).toHaveBeenCalledTimes(1);
        expect(current.destroy).not.toHaveBeenCalled();

        // A subsequent corrupt replacement must not release the active book.
        selectFile('corrupt.epub').succeed();
        await tick();
        expect(broken.destroy).toHaveBeenCalledTimes(1);
        expect(current.destroy).not.toHaveBeenCalled();
        expect(document.querySelector('.chapter-label').textContent).toBe('Current 1');
    });

    test('retired book waits for an in-progress chapter before releasing archive', async () => {
        const a = createMockBook('Book A');
        const b = createMockBook('Book B');
        books.push(a, b);
        selectFile('a.epub').succeed();
        await expectLoaded('Book A');
        const oldChapter = deferred();
        a.sections[1].load.mockImplementationOnce(() => oldChapter.promise);
        document.getElementById('nextChapter').click();
        await tick();
        selectFile('b.epub').succeed();
        for (let n = 0; n < 30 &&
            !messages.some((_, index) => index >= 1); n++) await tick();
        expect(document.querySelector('.chapter-label').textContent).toBe('Book B 1');
        expect(a.destroy).not.toHaveBeenCalled();
        acknowledgeCurrentChapter();
        // The iframe acknowledged B, but A still has a section.load() in flight.
        expect(a.destroy).not.toHaveBeenCalled();
        oldChapter.resolve(documentWithText('Old chapter finish'));
        for (let n = 0; n < 30 && a.destroy.mock.calls.length === 0; n++) await tick();
        expect(a.destroy).toHaveBeenCalledTimes(1);
        // The now-stale old chapter never reloads its text into the player.
        expect(browser.storage.local.set.mock.calls.every(([value]) =>
            !value.pendingTitle.startsWith('Book A 2'))).toBe(true);
    });

    test('chapter-load failure is visible after the file picker has been dismissed', async () => {
        const a = createMockBook('Book A');
        books.push(a);
        selectFile('a.epub').succeed();
        await expectLoaded('Book A');

        const chapterError = document.getElementById('chapterError');
        const picker = document.getElementById('filePickerOverlay');
        expect(picker.style.display).toBe('none');
        expect(chapterError.hidden).toBe(true);
        expect(chapterError.getAttribute('role')).toBe('alert');
        a.sections[1].load.mockRejectedValueOnce(new Error('Unable to read chapter section'));
        document.getElementById('nextChapter').click();
        for (let i = 0; i < 30 && chapterError.hidden; i++) await tick();
        expect(chapterError.hidden).toBe(false);
        expect(chapterError.textContent).toContain('Unable to read chapter section');
        // Loading a new chapter clears the reader-side alert; the picker is
        // never reopened to report normal chapter navigation errors.
        document.getElementById('prevChapter').click();
        expect(chapterError.hidden).toBe(true);
        expect(chapterError.textContent).toBe('');
        expect(picker.style.display).toBe('none');
    });

    test('late failures from abandoned chapter navigation cannot overwrite current alert', async () => {
        const a = createMockBook('Book A');
        books.push(a);
        selectFile('a.epub').succeed();
        await expectLoaded('Book A');
        const oldSection = deferred();
        a.sections[1].load.mockImplementationOnce(() => oldSection.promise);
        document.getElementById('nextChapter').click();
        await tick();
        document.getElementById('prevChapter').click();
        await tick();
        oldSection.reject(new Error('Old chapter failure'));
        await tick();
        await tick();

        const alert = document.getElementById('chapterError');
        expect(alert.hidden).toBe(true);
        expect(alert.textContent).toBe('');
        expect(document.getElementById('filePickerOverlay').style.display).toBe('none');
        expect(browser.storage.local.set.mock.calls.every(([value]) =>
            !value.pendingTitle.startsWith('Book A 2'))).toBe(true);
    });

    test('old EPUB image blob URLs are revoked by value only after iframe acknowledgment', async () => {
        const a = createMockBook('Book A');
        const b = createMockBook('Book B');
        a.archive.urlCache = {
            'images/cover.png': 'blob:old-cover',
            'images/thumb.png': 'blob:old-cover',
            'images/chapter.png': 'blob:old-chapter',
            'styles/style.css': 'data:text/css;base64,YQ==',
        };
        b.archive.urlCache = { 'images/new.png': 'blob:new-cover' };
        books.push(a, b);
        selectFile('a.epub').succeed();
        await expectLoaded('Book A');

        messages.length = 0;
        selectFile('b.epub').succeed();
        for (let i = 0; i < 30 && messages.length === 0; i++) await tick();
        expect(messages).toEqual(['RELOAD_DATA']);
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        expect(a.destroy).not.toHaveBeenCalled();

        // An untrusted/unrelated frame must not release any archive.
        acknowledgeCurrentChapter({ source: null });
        await tick();
        expect(a.destroy).not.toHaveBeenCalled();

        acknowledgeCurrentChapter();
        for (let i = 0; i < 30 && a.destroy.mock.calls.length === 0; i++) await tick();
        expect(a.destroy).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL.mock.calls.map(([url]) => url).sort())
            .toEqual(['blob:old-chapter', 'blob:old-cover']);
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:new-cover');
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('images/cover.png');

        // Duplicate acknowledgments cannot dispose already-released resources.
        acknowledgeCurrentChapter();
        await tick();
        expect(a.destroy).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    });

    test('a stale reload acknowledgment never destroys the old archive', async () => {
        const a = createMockBook('Book A');
        const b = createMockBook('Book B');
        books.push(a, b);
        selectFile('a.epub').succeed();
        await expectLoaded('Book A');
        const priorRevision = browser.storage.local.set.mock.lastCall[0].pendingReaderReloadRevision;

        messages.length = 0;
        selectFile('b.epub').succeed();
        for (let i = 0; i < 30 && messages.length === 0; i++) await tick();
        expect(messages).toEqual(['RELOAD_DATA']);
        acknowledgeCurrentChapter({ revision: priorRevision });
        await tick();
        expect(a.destroy).not.toHaveBeenCalled();

        acknowledgeCurrentChapter();
        for (let i = 0; i < 30 && a.destroy.mock.calls.length === 0; i++) await tick();
        expect(a.destroy).toHaveBeenCalledTimes(1);
    });

    test('abandoned candidate image blobs are revoked before book disposal', async () => {
        const abandoned = createMockBook('Broken');
        abandoned.archive.urlCache = { 'cover.png': 'blob:abandoned-cover' };
        abandoned.open.mockRejectedValueOnce(new Error('EPUB opening failed'));
        books.push(abandoned);
        selectFile('broken.epub').succeed();
        await tick();
        expect(abandoned.destroy).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:abandoned-cover');
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('cover.png');
    });

    test('reopening books does not multiply Previous/Next click handlers', async () => {
        const a = createMockBook('Book A');
        const b = createMockBook('Book B');
        books.push(a, b);
        selectFile('a.epub').succeed();
        await expectLoaded('Book A');
        selectFile('b.epub').succeed();
        for (let n = 0; n < 30 && document.querySelector('.chapter-label')?.textContent !== 'Book B 1'; n++) await tick();
        expect(document.querySelector('.chapter-label').textContent).toBe('Book B 1');
        // Wait for the first B chapter's async storage write to finish.
        await tick();
        const before = b.sections[1].load.mock.calls.length;
        document.getElementById('nextChapter').click();
        for (let n = 0; n < 30 && b.sections[1].load.mock.calls.length === before; n++) await tick();
        expect(b.sections[1].load.mock.calls.length - before).toBe(1);
        expect(document.getElementById('errorMsg').style.display).toBe('none');
    });
});
