/**
 * Shared jsdom helpers for popup unit tests (keeps Sonar new-code duplication low).
 */

const fs = require('fs');
const path = require('path');

function loadPopupDom({ injectCss = false } = {}) {
    const html = fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8');
    // Extract body contents (jsdom document already has html/head/body)
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : html;
    // Remove script tags from injected HTML — tests require scripts explicitly
    document.body.querySelectorAll('script').forEach((s) => s.remove());
    if (!injectCss) return;
    // Author CSS is required for computed-style checks (e.g. [hidden] vs display:flex).
    document.querySelectorAll('style[data-popup-css]').forEach((node) => node.remove());
    const style = document.createElement('style');
    style.setAttribute('data-popup-css', 'true');
    style.textContent = fs.readFileSync(path.join(__dirname, '../popup.css'), 'utf8');
    document.head.appendChild(style);
}

/**
 * Track document listeners registered while requiring popup.js so tests can
 * detach them in afterEach (popup.js binds DOMContentLoaded at import time).
 */
function createPopupModuleLoader() {
    const documentListeners = [];

    function loadPopupModule() {
        const addListener = document.addEventListener;
        document.addEventListener = function (type, handler, options) {
            documentListeners.push({ type, handler, options });
            return addListener.call(this, type, handler, options);
        };
        try {
            return require('../popup.js');
        } finally {
            document.addEventListener = addListener;
        }
    }

    function detachDocumentListeners() {
        for (const { type, handler, options } of documentListeners) {
            document.removeEventListener(type, handler, options);
        }
        documentListeners.length = 0;
    }

    return { loadPopupModule, detachDocumentListeners };
}

function installDefaultPopupGlobals({
    syncOverrides = {},
    manifestVersion = '1.4.0',
    commandsGetAll,
} = {}) {
    global.browser = {
        storage: {
            sync: {
                get: jest.fn(async (defaults) => ({
                    ...defaults,
                    apiUrl: 'http://127.0.0.1:8880/v1/',
                    voice: 'af_sarah',
                    mode: 'stream',
                    theme: 'light',
                    ...syncOverrides,
                })),
                set: jest.fn(async () => {}),
            },
            local: {
                set: jest.fn(async () => {}),
                get: jest.fn(async (defaults) => defaults),
            },
        },
        permissions: {
            contains: jest.fn(async () => true),
            request: jest.fn(async () => true),
        },
        runtime: {
            getManifest: jest.fn(() => ({ version: manifestVersion })),
        },
        tabs: { create: jest.fn() },
        commands: {
            getAll: jest.fn(
                async () => (typeof commandsGetAll === 'function'
                    ? commandsGetAll()
                    : [])
            ),
        },
    };
    global.localStorage = {
        getItem: jest.fn(),
        setItem: jest.fn(),
        removeItem: jest.fn(),
    };
    global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    Object.assign(global, require('../api-client.js'));
    Object.assign(global, { KokoroLocalVoiceMixing: require('../local-voice-mixing.js') });
    Object.assign(global, { KokoroBackendDisclosure: require('../backend-disclosure.js') });
}

module.exports = {
    loadPopupDom,
    createPopupModuleLoader,
    installDefaultPopupGlobals,
};
