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
}

describe('popup backend-loss resilience (#4)', () => {
    let popup;

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
        popup = require('../popup.js');
    });

    async function flushAsync() {
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
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
        require('../popup.js');
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
        require('../popup.js');
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
});
