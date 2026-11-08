/** @jest-environment jsdom */

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
    }));
    return {
        ready,
        navigation: { toc: names.map((href, i) => ({
            label: label + ' ' + (i + 1), href,
        })) },
        spine: {
            length: 2,
            get: jest.fn(id => typeof id === 'number'
                ? sections[id] : sections.find(s => s.href === id)),
        },
        load: jest.fn(),
        archive: { createUrl: jest.fn(async src => src) },
        sections,
    };
}
function mountReaderDOM() {
    document.body.innerHTML = `
        <div id="filePickerOverlay" style="display:block"></div>
        <div id="dropZone"></div>
        <input id="fileInput" type="file">
        <div id="file-name-display"></div>
        <div id="errorMsg" style="display:none"></div>
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
            succeed() {
                this.result = new ArrayBuffer(8);
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

    test('invalid EPUB parsing is shown as a load failure', async () => {
        const failed = deferred();
        books.push(createMockBook('Invalid', failed.promise));
        const reader = selectFile('corrupt.epub');
        reader.succeed();
        await tick();
        failed.reject(new Error('Invalid EPUB archive'));
        await tick();
        expect(document.getElementById('filePickerOverlay').style.display).toBe('block');
        expect(document.getElementById('errorMsg').textContent).toContain('Invalid EPUB archive');
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
