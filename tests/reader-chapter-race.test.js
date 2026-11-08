/** @jest-environment jsdom */

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

function readerDOM() {
    document.body.innerHTML = `
        <div id="filePickerOverlay"></div>
        <div id="dropZone"></div>
        <input type="file" id="fileInput">
        <div id="file-name-display"></div>
        <div id="errorMsg"></div>
        <div id="loadingStatus"></div>
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

function sectionDocument(text) {
    const doc = new DOMParser().parseFromString('<p>' + text + '</p>', 'text/html');
    return doc;
}

describe('EPUB chapter loading and storage ordering', () => {
    let chapterA;
    let chapterB;
    let removePending;
    let messages;
    let settings;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        readerDOM();
        chapterA = deferred();
        chapterB = deferred();
        removePending = deferred();
        messages = [];
        settings = {
            ttsBackend: 'mediapipe',
            mediaPipeVariant: 'cpu',
            localVoice: 'af_heart',
            autoplayReader: false,
        };
        global.browser = {
            storage: {
                local: {
                    remove: jest.fn(() => removePending.promise),
                    set: jest.fn(async () => {}),
                },
                sync: { get: jest.fn(async () => settings) },
            },
        };
        const makeSection = (href, index, controlled) => {
            let calls = 0;
            return {
                href, index, url: href,
                load: jest.fn(() => {
                    calls += 1;
                    // The first call belongs to the TOC scan, later ones to a
                    // genuine user chapter selection.
                    return calls === 1
                        ? Promise.resolve({ querySelectorAll: () => [] })
                        : controlled.promise;
                }),
            };
        };
        const sections = [
            makeSection('a.xhtml', 0, chapterA),
            makeSection('b.xhtml', 1, chapterB),
        ];
        const mockBook = {
            ready: Promise.resolve(),
            navigation: { toc: [
                { href: 'a.xhtml', label: 'Chapter A' },
                { href: 'b.xhtml', label: 'Chapter B' },
            ] },
            spine: {
                length: 2,
                get: jest.fn(index => typeof index === 'number'
                    ? sections[index] : sections.find(s => s.href === index)),
            },
            load: jest.fn(),
            archive: { createUrl: jest.fn(async name => name) },
        };
        global.ePub = jest.fn(() => mockBook);
        global.FileReader = class {
            readAsArrayBuffer() {
                void Promise.resolve().then(() =>
                    this.onload({ target: { result: new ArrayBuffer(1) } }));
            }
        };
        const frame = document.getElementById('playerFrame');
        frame.contentWindow.postMessage = jest.fn(value => messages.push(value));
        require('../reader.js');
    });

    async function openBook() {
        const input = document.getElementById('fileInput');
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [{ name: 'test.epub', type: 'application/epub+zip' }],
        });
        input.dispatchEvent(new Event('change'));
        for (let i = 0; i < 20; i++) {
            if (document.querySelectorAll('.chapter-item').length === 2) return;
            await nextTurn();
        }
        throw new Error('EPUB chapter list did not appear');
    }

    test('a slower old chapter cannot replace a newer selected chapter', async () => {
        removePending.resolve();
        await openBook();
        document.querySelector('[data-href="b.xhtml"]').click();
        chapterB.resolve(sectionDocument('The newer chapter B.'));
        await nextTurn();
        await nextTurn();

        expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
        expect(browser.storage.local.set.mock.calls[0][0])
            .toEqual(expect.objectContaining({ pendingTitle: 'Chapter B' }));
        expect(messages).toEqual(['RELOAD_DATA']);

        chapterA.resolve(sectionDocument('The older chapter A.'));
        await nextTurn();
        await nextTurn();

        expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
        expect(messages).toEqual(['RELOAD_DATA']);
    });

    test('the initial stale-data cleanup completes before first chapter storage write', async () => {
        await openBook();
        chapterA.resolve(sectionDocument('A fresh first chapter.'));
        await nextTurn();
        await nextTurn();

        expect(browser.storage.local.remove).toHaveBeenCalledTimes(1);
        expect(browser.storage.local.set).not.toHaveBeenCalled();
        expect(messages).toEqual([]);

        removePending.resolve();
        await nextTurn();
        await nextTurn();

        expect(browser.storage.local.set).toHaveBeenCalledWith(
            expect.objectContaining({ pendingTitle: 'Chapter A' }));
        expect(messages).toEqual(['RELOAD_DATA']);
    });

    test('pending earlier write cannot overwrite the next chapter after it completes', async () => {
        removePending.resolve();
        const earlierWrite = deferred();
        browser.storage.local.set.mockImplementationOnce(() => earlierWrite.promise)
            .mockResolvedValue(undefined);
        await openBook();
        chapterA.resolve(sectionDocument('First chapter ready.'));
        for (let i = 0; i < 20 && browser.storage.local.set.mock.calls.length === 0; i++) {
            await nextTurn();
        }
        expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
        document.querySelector('[data-href="b.xhtml"]').click();
        chapterB.resolve(sectionDocument('New chapter ready.'));
        await nextTurn();
        expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
        expect(messages).toEqual([]);

        earlierWrite.resolve();
        for (let i = 0; i < 20 && messages.length === 0; i++) {
            await nextTurn();
        }
        expect(browser.storage.local.set.mock.calls.map(([value]) => value.pendingTitle))
            .toEqual(['Chapter A', 'Chapter B']);
        expect(messages).toEqual(['RELOAD_DATA']);
    });
});
