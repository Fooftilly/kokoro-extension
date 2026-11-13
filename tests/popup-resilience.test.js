/**
 * @jest-environment jsdom
 *
 * Settings popup must remain usable when the Kokoro backend is unavailable (#4).
 */

const fs = require('fs');
const path = require('path');

function loadPopupDom() {
    const html = fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8');
    // Extract body contents (jsdom document already has html/head/body)
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : html;
    // Remove script tags from injected HTML — we require scripts explicitly
    document.body.querySelectorAll('script').forEach((s) => s.remove());
    // Author CSS is required for computed-style checks (e.g. [hidden] vs display:flex).
    document.querySelectorAll('style[data-popup-css]').forEach((node) => node.remove());
    const style = document.createElement('style');
    style.setAttribute('data-popup-css', 'true');
    style.textContent = fs.readFileSync(path.join(__dirname, '../popup.css'), 'utf8');
    document.head.appendChild(style);
}

describe('popup backend-loss resilience (#4)', () => {
    let popup;
    let documentListeners = [];

    // Jest module resets do not remove popup.js's document-level listeners.
    // Capture them during module loading and remove them after each case.
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

    afterEach(() => {
        for (const { type, handler, options } of documentListeners) {
            document.removeEventListener(type, handler, options);
        }
        documentListeners = [];
    });

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        jest.useRealTimers();
        loadPopupDom();

        global.browser = {
            storage: {
                sync: {
                    get: jest.fn(async (defaults) => ({
                        ...defaults,
                        apiUrl: 'http://127.0.0.1:8880/v1/',
                        voice: 'af_sarah(0.5)+af_nicole(0.5)',
                        mode: 'stream',
                        theme: 'light',
                    })),
                    set: jest.fn(async () => {}),
                },
                local: {
                    set: jest.fn(async () => {}),
                    get: jest.fn(async defaults => defaults),
                },
            },
            permissions: {
                contains: jest.fn(async () => true),
                request: jest.fn(async () => true),
            },
            runtime: {
                getManifest: jest.fn(() => ({ version: '1.3.1' })),
            },
            tabs: {
                create: jest.fn(),
            },
        };

        global.localStorage = {
            getItem: jest.fn(),
            setItem: jest.fn(),
            removeItem: jest.fn(),
        };

        // Default: backend unreachable
        global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));

        Object.assign(global, require('../api-client.js'));
        Object.assign(global, { KokoroLocalVoiceMixing: require('../local-voice-mixing.js') });
        popup = loadPopupModule();
    });

    async function flushAsync() {
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
    }

    function allowOnnxSelection({ modelReady = true, dictionaryReady = true,
        revision = null } = {}) {
        const { manifestForVariant } = require('../model-catalog.js');
        const { ModelDataStore } = require('../model-data-store.js');
        const approved = revision ?? manifestForVariant('onnx', 'q8').revision;
        browser.storage.local.get.mockImplementation(async defaults => ({
            ...defaults, 'onnxValidatedRevision:q8': approved,
        }));
        browser.runtime.getURL = jest.fn(() => 'moz-extension://test/');
        global.caches = { open: jest.fn() };
        global.Response = class {};
        global.TransformStream = class {};
        jest.spyOn(ModelDataStore.prototype, 'status').mockImplementation(async manifest => ({
            ready: manifest.provider === 'dictionary' ? dictionaryReady : modelReady,
        }));
    }

    function allowMediaPipeSelection({ modelReady = true, revision = null } = {}) {
        const { manifestForVariant } = require('../model-catalog.js');
        const { ModelDataStore } = require('../model-data-store.js');
        const approved = revision ?? manifestForVariant('mediapipe', 'cpu').revision;
        browser.storage.local.get.mockImplementation(async defaults => ({
            ...defaults, 'mediapipeValidatedRevision:cpu': approved,
        }));
        browser.runtime.getURL = jest.fn(() => 'moz-extension://test/');
        global.caches = { open: jest.fn() };
        global.Response = class {};
        global.TransformStream = class {};
        jest.spyOn(ModelDataStore.prototype, 'status').mockImplementation(async () => ({
            ready: modelReady,
        }));
    }

    test('popup renders and settings remain editable when backend is down', async () => {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        expect(document.getElementById('apiUrl')).toBeTruthy();
        expect(document.getElementById('apiUrl').value).toContain('127.0.0.1');
        expect(document.getElementById('selectedVoices').innerHTML.length).toBeGreaterThan(0);
        expect(document.getElementById('voiceSearch')).toBeTruthy();
        expect(document.getElementById('defaultSpeed')).toBeTruthy();

        const statusEl = document.getElementById('apiStatus');
        const row = document.getElementById('apiStatusRow');
        expect(row.style.display).not.toBe('none');
        expect(statusEl.textContent).toMatch(/reach|Unable/i);
        expect(statusEl.textContent).not.toMatch(/Checking/i);
        expect(document.getElementById('retryApi').style.display).not.toBe('none');

        document.getElementById('apiUrl').value = 'http://192.168.1.10:8880/v1/';
        document.getElementById('saveApiUrl').click();
        await flushAsync();
        expect(browser.storage.sync.set).toHaveBeenCalled();
        const saved = browser.storage.sync.set.mock.calls.at(-1)[0];
        expect(saved.apiUrl).toContain('192.168.1.10');
    });

    test('invalid saved backend displays a controlled save error without reverting to FastAPI', async () => {
        browser.storage.sync.get.mockImplementation(async defaults => ({
            ...defaults, ttsBackend: 'missing-local-engine',
            apiUrl: '', voice: 'af_sarah', mode: 'stream', theme: 'light',
        }));
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        expect(document.querySelector('input[name="ttsBackend"]:checked')).toBeNull();
        browser.storage.sync.set.mockClear();
        document.getElementById('defaultSpeed').dispatchEvent(new Event('change'));
        await flushAsync();
        expect(document.getElementById('status').textContent).toMatch(/Choose a valid TTS backend/i);
        expect(browser.storage.sync.set).not.toHaveBeenCalled();
    });

    test('popup refuses to activate untested MediaPipe but keeps other settings intact', async () => {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        browser.storage.sync.set.mockClear();

        const radio = document.querySelector('input[name="ttsBackend"][value="mediapipe"]');
        radio.checked = true;
        radio.dispatchEvent(new Event('change'));
        await flushAsync();

        expect(browser.storage.sync.set).not.toHaveBeenCalledWith({ ttsBackend: 'mediapipe' });
        expect(document.querySelector('input[name="ttsBackend"]:checked').value).toBe('fastapi');
        expect(document.getElementById('backendExplanation').textContent).toMatch(/Test the installed model first/i);
    });

    test('autosave cannot enable MediaPipe while its asynchronous radio test is pending', async () => {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        browser.storage.sync.set.mockClear();

        // A checked radio is not a verified backend; generic settings writes
        // must gate it even before the radio change handler finishes.
        const radio = document.querySelector('input[name="ttsBackend"][value="mediapipe"]');
        radio.checked = true;
        document.getElementById('defaultSpeed').dispatchEvent(new Event('change'));
        await flushAsync();
        expect(browser.storage.sync.set).not.toHaveBeenCalledWith(expect.objectContaining({
            ttsBackend: 'mediapipe',
        }));
        const stored = browser.storage.sync.set.mock.calls.at(-1)[0];
        expect(stored).toHaveProperty('defaultSpeed');
        expect(stored).not.toHaveProperty('ttsBackend');
        expect(document.getElementById('status').textContent).toMatch(/MediaPipe was not activated/i);
    });

    test('stale failing MediaPipe validation cannot reset a newer server selection', async () => {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        browser.storage.sync.set.mockClear();

        let releaseValidation;
        browser.storage.local.get.mockImplementation(() => new Promise(resolve => {
            releaseValidation = resolve;
        }));
        const mediapipe = document.querySelector('input[name="ttsBackend"][value="mediapipe"]');
        const fastapi = document.querySelector('input[name="ttsBackend"][value="fastapi"]');
        mediapipe.checked = true;
        mediapipe.dispatchEvent(new Event('change'));
        await flushAsync();
        expect(typeof releaseValidation).toBe('function');

        fastapi.checked = true;
        fastapi.dispatchEvent(new Event('change'));
        await flushAsync();
        releaseValidation({ 'mediapipeValidatedRevision:cpu': null });
        await flushAsync();

        expect(document.querySelector('input[name="ttsBackend"]:checked').value).toBe('fastapi');
        expect(browser.storage.sync.set.mock.calls
            .some(([value]) => value.ttsBackend === 'mediapipe')).toBe(false);
        expect(browser.storage.sync.set.mock.calls
            .some(([value]) => value.ttsBackend === 'fastapi')).toBe(true);
    });

    test('refuses untested ONNX q8 in popup radio selection and generic autosave', async () => {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        browser.storage.sync.set.mockClear();
        const onnx = document.querySelector('input[name="ttsBackend"][value="onnx"]');
        onnx.checked = true;
        onnx.dispatchEvent(new Event('change'));
        await flushAsync();
        expect(document.querySelector('input[name="ttsBackend"]:checked').value).toBe('fastapi');
        expect(browser.storage.sync.set.mock.calls.some(([v]) => v.ttsBackend === 'onnx')).toBe(false);
        expect(document.getElementById('backendExplanation').textContent)
            .toMatch(/Test ONNX q8 with English text first/);

        onnx.checked = true; // Autosave must not bypass the same gate.
        document.getElementById('defaultSpeed').dispatchEvent(new Event('change'));
        await flushAsync();
        expect(browser.storage.sync.set.mock.calls.some(([v]) => v.ttsBackend === 'onnx')).toBe(false);
        expect(browser.storage.sync.set.mock.calls.some(([v]) =>
            v.defaultSpeed !== undefined && !Object.hasOwn(v, 'ttsBackend'))).toBe(true);
    });

    test.each([
        { modelReady: false, dictionaryReady: true },
        { modelReady: true, dictionaryReady: false },
        { modelReady: true, dictionaryReady: true, revision: '0'.repeat(40) },
    ])('blocks ONNX if required model, dictionary or revision is missing: %j', async options => {
        allowOnnxSelection(options);
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        browser.storage.sync.set.mockClear();
        const onnx = document.querySelector('input[name="ttsBackend"][value="onnx"]');
        onnx.checked = true;
        onnx.dispatchEvent(new Event('change'));
        await flushAsync();
        expect(document.querySelector('input[name="ttsBackend"]:checked').value).toBe('fastapi');
        expect(browser.storage.sync.set.mock.calls.some(([v]) => v.ttsBackend === 'onnx')).toBe(false);
    });

    test('serializes backend writes when an earlier storage operation is delayed', async () => {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        const completed = [];
        let resolveFirst;
        browser.storage.sync.set.mockReset();
        browser.storage.sync.set.mockImplementation(settings => {
            if (!resolveFirst) {
                return new Promise(resolve => {
                    resolveFirst = () => { completed.push(settings.ttsBackend); resolve(); };
                });
            }
            completed.push(settings.ttsBackend);
            return Promise.resolve();
        });

        allowOnnxSelection();
        const onnx = document.querySelector('input[name="ttsBackend"][value="onnx"]');
        const fastapi = document.querySelector('input[name="ttsBackend"][value="fastapi"]');
        onnx.checked = true;
        onnx.dispatchEvent(new Event('change'));
        await flushAsync();
        expect(typeof resolveFirst).toBe('function');

        fastapi.checked = true;
        fastapi.dispatchEvent(new Event('change'));
        await flushAsync();
        expect(completed).toEqual([]);
        resolveFirst();
        await flushAsync();

        expect(completed).toEqual(['onnx', 'fastapi']);
        expect(document.querySelector('input[name="ttsBackend"]:checked').value).toBe('fastapi');
    });

    test('pending MediaPipe autosave cannot overwrite a newer backend', async () => {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        browser.storage.sync.set.mockClear();
        let releaseValidation;
        browser.storage.local.get.mockImplementation(() => new Promise(resolve => {
            releaseValidation = resolve;
        }));

        const mediapipe = document.querySelector('input[name="ttsBackend"][value="mediapipe"]');
        mediapipe.checked = true;
        document.getElementById('defaultSpeed').dispatchEvent(new Event('change'));
        await flushAsync();
        expect(typeof releaseValidation).toBe('function');

        const fastapi = document.querySelector('input[name="ttsBackend"][value="fastapi"]');
        fastapi.checked = true;
        fastapi.dispatchEvent(new Event('change'));
        releaseValidation({ 'mediapipeValidatedRevision:cpu': null });
        await flushAsync();

        const stored = browser.storage.sync.set.mock.calls;
        expect(stored.some(([value]) => value.ttsBackend === 'mediapipe')).toBe(false);
        expect(stored.some(([value]) => value.ttsBackend === 'fastapi')).toBe(true);
        expect(stored.some(([value]) => value.defaultSpeed !== undefined &&
            Object.hasOwn(value, 'ttsBackend'))).toBe(false);
    });

    test('failed MediaPipe retest does not block other settings from being saved', async () => {
        browser.storage.sync.get.mockImplementation(async defaults => ({
            ...defaults, ttsBackend: 'mediapipe', mediaPipeVariant: 'cpu',
            apiUrl: '', voice: 'af_sarah', mode: 'stream', theme: 'light',
        }));
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        browser.storage.sync.set.mockClear();

        document.getElementById('defaultSpeed').value = '1.5';
        document.getElementById('defaultSpeed').dispatchEvent(new Event('change'));
        await flushAsync();

        const saved = browser.storage.sync.set.mock.calls.at(-1)[0];
        expect(saved).toEqual(expect.objectContaining({ defaultSpeed: '1.5' }));
        expect(saved).not.toHaveProperty('ttsBackend');
        expect(document.querySelector('input[name="ttsBackend"]:checked').value).toBe('mediapipe');
        expect(document.getElementById('status').textContent).toMatch(/MediaPipe was not activated/i);
    });

    test('invalid backend Save does not request a server permission or probe', async () => {
        browser.storage.sync.get.mockImplementation(async defaults => ({
            ...defaults, ttsBackend: 'unknown', apiUrl: '',
            voice: 'af_sarah', mode: 'stream', theme: 'light',
        }));
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        global.fetch.mockClear();
        browser.permissions.request.mockClear();
        document.getElementById('saveApiUrl').click();
        await flushAsync();

        expect(browser.permissions.request).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(document.getElementById('status').textContent).toMatch(/Choose a valid TTS backend/i);
    });

    test('malformed voices response is not labeled unreachable', async () => {
        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('/test') || String(url).endsWith('test')) {
                return { ok: true, json: async () => ({ status: 'ok' }) };
            }
            return {
                ok: true,
                json: async () => ({ voices: [{ id: 'af_alloy', name: 'af_alloy' }] }),
            };
        });

        jest.resetModules();
        loadPopupDom();
        Object.assign(global, require('../api-client.js'));
        Object.assign(global, { KokoroLocalVoiceMixing: require('../local-voice-mixing.js') });
        loadPopupModule();
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        expect(document.getElementById('apiStatus').textContent).toMatch(/Connected/i);

        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('test')) {
                return { ok: true, json: async () => ({ status: 'ok' }) };
            }
            return { ok: true, json: async () => ({ not_voices: true }) };
        });
        document.getElementById('saveApiUrl').click();
        await flushAsync();

        const text = document.getElementById('apiStatus').textContent;
        expect(text).toMatch(/unsupported|format/i);
        expect(text).not.toMatch(/Unable to reach/i);
        expect(document.getElementById('apiUrl').disabled).toBeFalsy();
        expect(document.getElementById('selectedVoices')).toBeTruthy();
    });

    test('recovery after failure refreshes voices without reopening', async () => {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        expect(document.getElementById('apiStatus').textContent).toMatch(/reach/i);

        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('test')) {
                return { ok: true, json: async () => ({ status: 'ok' }) };
            }
            return {
                ok: true,
                json: async () => ({
                    voices: [
                        { id: 'af_alloy', name: 'af_alloy' },
                        { id: 'bm_george', name: 'bm_george' },
                    ],
                }),
            };
        });

        document.getElementById('retryApi').click();
        await flushAsync();

        expect(document.getElementById('apiStatus').textContent).toMatch(/Connected/i);

        const search = document.getElementById('voiceSearch');
        search.value = 'af_';
        search.dispatchEvent(new Event('input'));
        const dropdown = document.getElementById('voiceDropdown');
        expect(dropdown.textContent).toContain('af_alloy');
        expect(dropdown.textContent).not.toMatch(/reach/i);
    });

    test('permission denial is not overwritten by a network refresh', async () => {
        browser.permissions.contains.mockResolvedValue(false);
        browser.permissions.request.mockResolvedValue(false);
        global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));

        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        document.getElementById('apiUrl').value = 'http://192.168.1.50:8880/v1/';
        document.getElementById('saveApiUrl').click();
        await flushAsync();

        const text = document.getElementById('apiStatus').textContent;
        expect(text).toMatch(/permission/i);
        expect(text).not.toMatch(/Unable to reach/i);
        expect(browser.storage.sync.set).toHaveBeenCalled();
    });

    test('denied permission → Retry keeps permission status (not network)', async () => {
        browser.permissions.contains.mockResolvedValue(false);
        browser.permissions.request.mockResolvedValue(false);
        global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));

        // Finish open restore first so it cannot overwrite the remote URL mid-test.
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        global.fetch.mockClear();

        document.getElementById('apiUrl').value = 'http://192.168.1.50:8880/v1/';
        await popup.refreshBackendStatus('http://192.168.1.50:8880/v1/');
        await flushAsync();
        expect(document.getElementById('apiStatus').textContent).toMatch(/permission/i);
        expect(global.fetch).not.toHaveBeenCalled();

        // Retry click starts permissions.request synchronously, then refreshes.
        global.fetch.mockClear();
        browser.permissions.request.mockClear();
        document.getElementById('retryApi').click();
        await flushAsync();

        expect(document.getElementById('apiStatus').textContent).toMatch(/permission/i);
        expect(document.getElementById('apiStatus').textContent).not.toMatch(/Unable to reach/i);
        expect(browser.permissions.request).toHaveBeenCalled();
        // Still denied — must not fall through to fetch/network labeling
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('Save starts permissions.request before awaiting storage (Firefox gesture)', async () => {
        const order = [];
        browser.permissions.contains.mockResolvedValue(false);
        browser.permissions.request.mockImplementation(() => {
            order.push('request');
            return Promise.resolve(false);
        });
        browser.storage.sync.set.mockImplementation(async () => {
            order.push('storage');
        });
        browser.storage.local.set.mockImplementation(async () => {});
        global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));

        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        order.length = 0;
        browser.permissions.request.mockClear();
        browser.storage.sync.set.mockClear();
        global.fetch.mockClear();

        document.getElementById('apiUrl').value = 'http://192.168.1.50:8880/v1/';
        document.getElementById('saveApiUrl').click();
        await flushAsync();

        expect(browser.permissions.request).toHaveBeenCalled();
        expect(order.indexOf('request')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('storage')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('request')).toBeLessThan(order.indexOf('storage'));
        expect(document.getElementById('apiStatus').textContent).toMatch(/permission/i);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('rejected permissions.request maps to permission (not network)', async () => {
        browser.permissions.contains.mockResolvedValue(false);
        browser.permissions.request.mockImplementation(() => Promise.reject(new Error('user gesture required')));
        global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));

        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();
        global.fetch.mockClear();

        document.getElementById('apiUrl').value = 'http://10.0.0.9:8880/v1/';
        document.getElementById('retryApi').style.display = 'inline-block';
        document.getElementById('retryApi').click();
        await flushAsync();

        expect(document.getElementById('apiStatus').textContent).toMatch(/permission/i);
        expect(document.getElementById('apiStatus').textContent).not.toMatch(/Unable to reach/i);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('denied permission → reopen shows permission (not network)', async () => {
        browser.storage.sync.get.mockImplementation(async (defaults) => ({
            ...defaults,
            apiUrl: 'http://192.168.1.77:8880/v1/',
            voice: 'af_sarah',
            mode: 'stream',
            theme: 'light',
        }));
        browser.permissions.contains.mockResolvedValue(false);
        global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));

        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        expect(document.getElementById('apiUrl').value).toContain('192.168.1.77');
        expect(document.getElementById('apiStatus').textContent).toMatch(/permission/i);
        expect(document.getElementById('apiStatus').textContent).not.toMatch(/Unable to reach/i);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(browser.permissions.request).not.toHaveBeenCalled();
    });

    test('stale refresh cannot overwrite a newer URL result', async () => {
        let resolveStale;
        const stalePromise = new Promise((resolve) => {
            resolveStale = resolve;
        });

        global.fetch = jest.fn((url) => {
            const u = String(url);
            if (u.includes('127.0.0.1')) {
                return stalePromise.then(() => {
                    if (u.includes('test')) {
                        return { ok: true, json: async () => ({ status: 'ok' }) };
                    }
                    return {
                        ok: true,
                        json: async () => ({ voices: [{ id: 'af_stale', name: 'af_stale' }] }),
                    };
                });
            }
            // New URL responds immediately
            if (u.includes('test') || u.includes('/health')) {
                return Promise.resolve({ ok: true, json: async () => ({ status: 'ok' }) });
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({ voices: [{ id: 'af_fresh', name: 'af_fresh' }] }),
            });
        });

        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        // Open refresh still waiting on stale host
        expect(document.getElementById('apiStatus').textContent).toMatch(/Checking/i);

        document.getElementById('apiUrl').value = 'http://10.0.0.2:8880/v1/';
        document.getElementById('saveApiUrl').click();
        await flushAsync();

        expect(document.getElementById('apiStatus').textContent).toMatch(/Connected/i);
        expect(popup.getAvailableVoices()).toContain('af_fresh');

        // Late stale responses must not win
        resolveStale();
        await flushAsync();
        expect(popup.getAvailableVoices()).toContain('af_fresh');
        expect(popup.getAvailableVoices()).not.toContain('af_stale');
        expect(document.getElementById('apiStatus').textContent).toMatch(/Connected/i);
    });

    test('/test HTTP failure with successful voices still shows connected', async () => {
        global.fetch = jest.fn(async (url) => {
            const u = String(url);
            if (u.includes('/test')) {
                return { ok: false, status: 404 };
            }
            if (u.includes('/health')) {
                return { ok: false, status: 404 };
            }
            return {
                ok: true,
                json: async () => ({ voices: [{ id: 'af_alloy', name: 'af_alloy' }] }),
            };
        });

        jest.resetModules();
        loadPopupDom();
        Object.assign(global, require('../api-client.js'));
        Object.assign(global, { KokoroLocalVoiceMixing: require('../local-voice-mixing.js') });
        loadPopupModule();
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        const text = document.getElementById('apiStatus').textContent;
        expect(text).toMatch(/Connected/i);
        expect(text).not.toMatch(/HTTP/i);

        const search = document.getElementById('voiceSearch');
        search.value = 'af_';
        search.dispatchEvent(new Event('input'));
        expect(document.getElementById('voiceDropdown').textContent).toContain('af_alloy');
    });

    test('editing URL during refresh clears stuck Checking and shows Retry', async () => {
        const resolvers = [];
        global.fetch = jest.fn(() => new Promise((resolve) => {
            resolvers.push(resolve);
        }));

        document.getElementById('apiUrl').value = 'http://127.0.0.1:8880/v1/';
        const pending = popup.refreshBackendStatus('http://127.0.0.1:8880/v1/', {
            timeoutMs: 10000,
        });
        await flushAsync();
        expect(document.getElementById('apiStatus').textContent).toMatch(/Checking/i);
        expect(document.getElementById('retryApi').style.display).toBe('none');
        expect(resolvers.length).toBeGreaterThanOrEqual(1);

        // Edit URL without Save — no new refresh starts
        document.getElementById('apiUrl').value = 'http://10.0.0.9:8880/v1/';

        // Complete /test; refresh should discard and clear Checking (not apply voices)
        resolvers[0]({
            ok: true,
            json: async () => ({ status: 'ok' }),
        });
        await pending;
        await flushAsync();

        expect(document.getElementById('apiStatus').textContent).not.toMatch(/Checking/i);
        expect(document.getElementById('retryApi').style.display).not.toBe('none');
        expect(popup.getAvailableVoices()).toEqual([]);
    });

    test('never-resolving fetch ends Checking via timeout', async () => {
        jest.useFakeTimers();
        global.fetch = jest.fn(() => new Promise(() => {}));
        // Match input URL so stillCurrent() stays true during the probe
        document.getElementById('apiUrl').value = 'http://127.0.0.1:8880/v1/';

        const pending = popup.refreshBackendStatus('http://127.0.0.1:8880/v1/', {
            timeoutMs: 30,
        });
        expect(document.getElementById('apiStatus').textContent).toMatch(/Checking/i);

        // probe: /test timeout + /health timeout, then voices timeout
        await jest.advanceTimersByTimeAsync(30);
        await jest.advanceTimersByTimeAsync(30);
        await jest.advanceTimersByTimeAsync(30);
        await pending;

        expect(document.getElementById('apiStatus').textContent).not.toMatch(/Checking/i);
        expect(document.getElementById('apiStatus').textContent).toMatch(/reach|Unable/i);
        expect(document.getElementById('retryApi').style.display).not.toBe('none');
        jest.useRealTimers();
    });

    test('popup migrates legacy localVoice when mediaPipeVoice is unset (#59)', async () => {
        allowMediaPipeSelection();
        browser.storage.sync.get.mockImplementation(async (defaults) => {
            const merged = {
                ...defaults,
                apiUrl: 'http://127.0.0.1:8880/v1/',
                ttsBackend: 'mediapipe',
                mediaPipeVariant: 'cpu',
                voice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
                localVoice: 'af_bella',
                mode: 'stream',
                theme: 'light',
            };
            delete merged.mediaPipeVoice;
            return merged;
        });

        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        expect(document.getElementById('mediaPipeVoice').value).toBe('af_bella');
        const getArg = browser.storage.sync.get.mock.calls[0][0];
        expect(Object.hasOwn(getArg, 'mediaPipeVoice')).toBe(false);
    });

    test('local-voice containers honor [hidden] under author display:flex (#59)', async () => {
        allowMediaPipeSelection();
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        const mediaPipeBox = document.getElementById('mediaPipeVoiceContainer');
        const onnxBox = document.getElementById('onnxVoiceContainer');
        expect(mediaPipeBox.classList.contains('local-voice-container')).toBe(true);
        expect(onnxBox.classList.contains('local-voice-container')).toBe(true);

        // FastAPI: both local containers must be display:none despite display:flex.
        expect(mediaPipeBox.hidden).toBe(true);
        expect(onnxBox.hidden).toBe(true);
        expect(getComputedStyle(mediaPipeBox).display).toBe('none');
        expect(getComputedStyle(onnxBox).display).toBe('none');

        popup.syncVoiceUiForBackend('mediapipe');
        expect(mediaPipeBox.hidden).toBe(false);
        expect(onnxBox.hidden).toBe(true);
        expect(getComputedStyle(mediaPipeBox).display).toBe('flex');
        expect(getComputedStyle(onnxBox).display).toBe('none');

        popup.syncVoiceUiForBackend('onnx');
        expect(mediaPipeBox.hidden).toBe(true);
        expect(onnxBox.hidden).toBe(false);
        expect(getComputedStyle(mediaPipeBox).display).toBe('none');
        expect(getComputedStyle(onnxBox).display).toBe('flex');

        popup.syncVoiceUiForBackend('fastapi');
        expect(mediaPipeBox.hidden).toBe(true);
        expect(onnxBox.hidden).toBe(true);
        expect(getComputedStyle(mediaPipeBox).display).toBe('none');
        expect(getComputedStyle(onnxBox).display).toBe('none');
    });

    test('ONNX save pins onnxVoiceAsset and leaves FastAPI mix untouched (#59)', async () => {
        allowOnnxSelection();
        browser.storage.sync.get.mockImplementation(async (defaults) => ({
            ...defaults,
            apiUrl: 'http://127.0.0.1:8880/v1/',
            ttsBackend: 'onnx',
            voice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
            mediaPipeVoice: 'af_bella',
            onnxVoiceAsset: 'voices/af.bin',
            mode: 'stream',
            theme: 'light',
        }));

        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        expect(document.getElementById('voiceMixerContainer').hidden).toBe(true);
        expect(document.getElementById('mediaPipeVoiceContainer').hidden).toBe(true);
        expect(document.getElementById('onnxVoiceContainer').hidden).toBe(false);
        expect(document.getElementById('onnxVoiceAsset').disabled).toBe(true);
        expect(document.getElementById('onnxVoiceAsset').readOnly).toBe(true);
        expect(document.getElementById('onnxVoiceAsset').value).toBe('voices/af.bin');
        expect(document.getElementById('localVoiceNote').textContent).toMatch(/af\.bin/i);
        expect(document.getElementById('localVoiceNote').textContent).toMatch(/no effect/i);

        browser.storage.sync.set.mockClear();
        await popup.saveOptions(false);

        const writes = browser.storage.sync.set.mock.calls.map(([payload]) => payload);
        expect(writes.some((payload) => payload.onnxVoiceAsset === 'voices/af.bin')).toBe(true);
        expect(writes.every((payload) => !Object.hasOwn(payload, 'voice'))).toBe(true);
        expect(writes.every((payload) => !Object.hasOwn(payload, 'mediaPipeVoice'))).toBe(true);
        expect(writes.every((payload) => !Object.hasOwn(payload, 'localVoice'))).toBe(true);
    });

    test('MediaPipe save writes mediaPipeVoice only and keeps FastAPI mix (#59)', async () => {
        allowMediaPipeSelection();
        browser.storage.sync.get.mockImplementation(async (defaults) => ({
            ...defaults,
            apiUrl: 'http://127.0.0.1:8880/v1/',
            ttsBackend: 'mediapipe',
            mediaPipeVariant: 'cpu',
            voice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
            mediaPipeVoice: 'af_heart',
            onnxVoiceAsset: 'voices/af.bin',
            mode: 'stream',
            theme: 'light',
        }));

        document.dispatchEvent(new Event('DOMContentLoaded'));
        await flushAsync();

        expect(document.getElementById('voiceMixerContainer').hidden).toBe(true);
        expect(document.getElementById('mediaPipeVoiceContainer').hidden).toBe(false);
        expect(document.getElementById('onnxVoiceContainer').hidden).toBe(true);
        expect(document.getElementById('mediaPipeVoice').disabled).toBe(false);

        document.getElementById('mediaPipeVoice').value = 'af_bella';
        browser.storage.sync.set.mockClear();
        await popup.saveOptions(false);

        const writes = browser.storage.sync.set.mock.calls.map(([payload]) => payload);
        expect(writes.some((payload) => payload.mediaPipeVoice === 'af_bella')).toBe(true);
        expect(writes.every((payload) => !Object.hasOwn(payload, 'voice'))).toBe(true);
        expect(writes.every((payload) => !Object.hasOwn(payload, 'onnxVoiceAsset'))).toBe(true);
    });
});
