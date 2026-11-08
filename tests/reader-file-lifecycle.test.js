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

    test('scanning all spine sections and playing one chapter unloads their DOMs', async () => {
        const a = createMockBook('Book A');
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
        b.sections[0].load.mockImplementationOnce(async () =>
            documentWithText('TOC B')).mockImplementationOnce(() => nextReady.promise);
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
