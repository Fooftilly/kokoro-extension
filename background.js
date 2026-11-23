try {
    if (typeof importScripts === 'function') {
        importScripts('browser-polyfill.min.js');
        importScripts('tts-providers.js');
        importScripts('local-voice-mixing.js');
        importScripts('toolbar-status.js');
        // Classic catalog lite + readiness (Chrome SW cannot dynamic-import ES modules).
        importScripts('model-catalog-lite.js');
        importScripts('local-model-readiness.js');
    }
} catch (e) {
    console.error("Polyfill load error:", e);
}

// Firefox loads helper scripts before this background script via its manifest.
// Jest uses the same pure helpers via CommonJS.
const TtsProviders = typeof require === 'function'
    ? require('./tts-providers.js')
    : globalThis.KokoroTtsProviders;
const LocalVoice = typeof require === 'function'
    ? require('./local-voice-mixing.js')
    : globalThis.KokoroLocalVoiceMixing;
const ToolbarStatus = typeof require === 'function'
    ? require('./toolbar-status.js')
    : globalThis.KokoroToolbarStatus;
const LocalModelReadiness = typeof require === 'function'
    ? require('./local-model-readiness.js')
    : globalThis.KokoroLocalModelReadiness;

browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
        id: "send-to-kokoro",
        title: "Send to Kokoro TTS",
        contexts: ["selection"]
    });
    browser.contextMenus.create({
        id: "read-article-kokoro",
        title: "Read Article with Kokoro TTS",
        contexts: ["page"]
    });
});

const sanitizeFilename = (name) => {
    return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
};

const notify = (title, message) => {
    browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: title,
        message: message
    });
};

let isChecking = false;
/** Set when checkApiStatus is requested while a probe is already in flight. */
let pendingToolbarCheck = false;
/** Shared promise so callers can await a coalesced in-flight check. */
let toolbarCheckPromise = null;

function applyToolbarStatus(status) {
    const kind = status?.kind || ToolbarStatus.KIND.UNKNOWN;
    const title = ToolbarStatus.titleForStatus(status);
    browser.action.setIcon({ path: ToolbarStatus.iconPathsForKind(kind) });
    if (browser.action.setTitle) {
        browser.action.setTitle({ title });
    }
    return { kind, title, backend: status?.backend || null };
}

/**
 * Read-only local readiness from validated-revision keys + Cache Storage metadata.
 * Never probes FastAPI and never initializes a heavy TTS runtime.
 * Uses classic-script helpers (importScripts / catalog lite) — no dynamic import().
 */
async function probeLocalToolbarStatus(backend, settings) {
    if (typeof caches === 'undefined' || typeof caches.open !== 'function') {
        return {
            kind: ToolbarStatus.KIND.UNAVAILABLE,
            backend,
            detail: 'Cache Storage unavailable',
        };
    }
    if (!LocalModelReadiness || typeof LocalModelReadiness.probeLocalBackend !== 'function') {
        return {
            kind: ToolbarStatus.KIND.UNAVAILABLE,
            backend,
            detail: 'local readiness helper unavailable',
        };
    }
    try {
        return await LocalModelReadiness.probeLocalBackend(
            backend,
            settings,
            {
                origin: browser.runtime.getURL('/'),
                cacheStorage: caches,
                fetchImpl: fetch.bind(globalThis),
                responseClass: Response,
                streamClass: typeof TransformStream === 'function' ? TransformStream : undefined,
                storageLocal: browser.storage.local,
            },
            {
                classifyLocalReadiness: ToolbarStatus.classifyLocalReadiness,
                normalizeOnnxVoiceAsset: LocalVoice.normalizeOnnxVoiceAsset,
                onnxFixedVoice: LocalVoice.ONNX_FIXED_VOICE_ASSET,
            }
        );
    } catch (error) {
        console.warn('Kokoro: local toolbar status probe failed', error);
        return {
            kind: ToolbarStatus.KIND.FAILED,
            backend,
            detail: String(error?.message || error || 'probe failed'),
        };
    }
}

async function probeFastApiToolbarStatus(apiUrl) {
    let normalized = apiUrl;
    if (!normalized.endsWith('/')) normalized += '/';

    const tryFetch = async (url) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        try {
            return await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    };

    let connected = false;
    try {
        const testUrl = new URL('test', normalized).href;
        const resp = await tryFetch(testUrl);
        if (resp.ok) {
            const json = await resp.json();
            if (json.status === 'ok') connected = true;
        }
    } catch (_) { /* ignore */ }

    if (!connected) {
        try {
            const healthUrl = new URL('/health', new URL(normalized).origin).href;
            const resp = await tryFetch(healthUrl);
            if (resp.ok) {
                const json = await resp.json();
                if (json.status === 'healthy') connected = true;
            }
        } catch (_) { /* ignore */ }
    }

    return {
        kind: connected ? ToolbarStatus.KIND.READY : ToolbarStatus.KIND.UNREACHABLE,
        backend: TtsProviders.FASTAPI,
        detail: null,
    };
}

const checkApiStatus = async () => {
    // Coalesce overlapping requests so a backend switch during a slow FastAPI
    // probe is not dropped by the in-flight guard (#208 race).
    if (isChecking && toolbarCheckPromise) {
        pendingToolbarCheck = true;
        return toolbarCheckPromise;
    }
    isChecking = true;
    toolbarCheckPromise = (async () => {
        try {
            do {
                pendingToolbarCheck = false;
                const settings = await browser.storage.sync.get({
                    apiUrl: 'http://127.0.0.1:8880/v1/',
                    ttsBackend: TtsProviders.FASTAPI,
                    mediaPipeVariant: 'cpu',
                    onnxVoiceAsset: 'voices/af.bin',
                });
                let backend;
                try {
                    backend = TtsProviders.resolveBackend(settings.ttsBackend);
                } catch (_) {
                    applyToolbarStatus({
                        kind: ToolbarStatus.KIND.UNKNOWN,
                        backend: settings.ttsBackend,
                        detail: 'unknown backend',
                    });
                    continue;
                }

                let status;
                if (backend !== TtsProviders.FASTAPI) {
                    // Do not probe an HTTP server when a local engine was selected.
                    status = await probeLocalToolbarStatus(backend, settings);
                } else {
                    status = await probeFastApiToolbarStatus(settings.apiUrl);
                }

                // If prefs changed during the probe, skip applying the stale result
                // and loop with the latest settings.
                if (pendingToolbarCheck) continue;

                const latest = await browser.storage.sync.get({
                    ttsBackend: TtsProviders.FASTAPI,
                });
                let latestBackend;
                try {
                    latestBackend = TtsProviders.resolveBackend(latest.ttsBackend);
                } catch (_) {
                    latestBackend = null;
                }
                if (latestBackend !== backend) {
                    pendingToolbarCheck = true;
                    continue;
                }

                applyToolbarStatus(status);
            } while (pendingToolbarCheck);
        } catch (e) {
            console.error('Toolbar status check failed completely:', e);
            applyToolbarStatus({
                kind: ToolbarStatus.KIND.UNKNOWN,
                backend: null,
                detail: String(e?.message || e),
            });
        } finally {
            isChecking = false;
            toolbarCheckPromise = null;
            // A request may have arrived after the loop exited but before we cleared
            // the lock — schedule one more pass.
            if (pendingToolbarCheck) {
                pendingToolbarCheck = false;
                void checkApiStatus();
            }
        }
    })();
    return toolbarCheckPromise;
};

/** FastAPI-only minute alarm — cleared while a local backend is selected (#208). */
async function syncToolbarAlarm() {
    try {
        const { ttsBackend } = await browser.storage.sync.get({
            ttsBackend: TtsProviders.FASTAPI,
        });
        if (TtsProviders.resolveBackend(ttsBackend) === TtsProviders.FASTAPI) {
            browser.alarms.create('api-check', { periodInMinutes: 1 });
        } else if (browser.alarms.clear) {
            await browser.alarms.clear('api-check');
        }
    } catch (_) {
        if (browser.alarms.clear) {
            try { await browser.alarms.clear('api-check'); } catch (__) { /* ignore */ }
        }
    }
}

// Initial check + alarm aligned to current backend.
void checkApiStatus().then(() => syncToolbarAlarm());

browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'api-check') {
        void checkApiStatus();
    }
});

// Refresh after backend/model preference changes, validation-key updates, and
// model-manager Cache Storage mutations (localModelCacheEpoch).
browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (
        changes.apiUrl ||
        changes.ttsBackend ||
        changes.mediaPipeVariant ||
        changes.onnxVoiceAsset
    )) {
        void checkApiStatus();
        if (changes.ttsBackend) void syncToolbarAlarm();
        return;
    }
    if (area === 'local' && Object.keys(changes).some((key) =>
        ToolbarStatus.isValidatedRevisionStorageKey(key) ||
        ToolbarStatus.isLocalModelCacheEpochKey(key)
    )) {
        void checkApiStatus();
    }
});

// Helper to ensure content script is injected
async function ensureContentScript(tabId) {
    try {
        // Try a simple ping
        await browser.tabs.sendMessage(tabId, { action: "PING" });
    } catch (e) {
        // If ping fails, inject
        console.log("Injecting content script into tab " + tabId);
        try {
            await browser.scripting.executeScript({
                target: { tabId: tabId },
                // Match manifest content_scripts order: position helpers before content.js
                files: ['browser-polyfill.min.js', 'readability.js', 'overlay-position.js', 'floating-mic-position.js', 'content.js']
            });
            // Brief wait for script to populate listener
            await new Promise(r => setTimeout(r, 100));
        } catch (err) {
            console.error("Failed to inject content script:", err);
            throw err;
        }
    }
}

async function handleTtsAction(tab, actionType, selectionText = "") {
    let text = "";
    let structuredContent = null;
    const isArticleMode = actionType === "read-article-kokoro" || actionType === "read-article";

    if (isArticleMode) {
        // We need to ask the content script to parse the page
        try {
            // Robust Send: Try once, if fail, inject and retry
            try {
                const response = await browser.tabs.sendMessage(tab.id, { action: "PARSE_ARTICLE" });
                if (response && response.text) {
                    text = response.text;
                    structuredContent = response.content;
                } else {
                    throw new Error("No text returned");
                }
            } catch (e) {
                // Retry logic
                console.log("Initial parse failed, trying to inject...", e);
                await ensureContentScript(tab.id);
                const response = await browser.tabs.sendMessage(tab.id, { action: "PARSE_ARTICLE" });
                if (response && response.text) {
                    text = response.text;
                    structuredContent = response.content;
                } else {
                    notify("Kokoro TTS", "Could not extract article text.");
                    return;
                }
            }
        } catch (e) {
            console.error("Parse failed after retry:", e);
            notify("Kokoro TTS Error", "Reload the page to use this feature.");
            return;
        }
    } else {
        text = selectionText;
    }

    if (!text) return;

    // Get settings
    const settings = await browser.storage.sync.get({
        apiUrl: 'http://127.0.0.1:8880/v1/',
        ttsBackend: TtsProviders.FASTAPI,
        mediaPipeVariant: 'cpu',
        // Do not default mediaPipeVoice here — that would mask legacy localVoice.
        onnxVoiceAsset: 'voices/af.bin',
        localVoice: 'af_heart',
        voice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
        mode: 'stream',
        autoScroll: false,
        normalizationOptions: {
            normalize: true,
            unit_normalization: false,
            url_normalization: true,
            email_normalization: true,
            optional_pluralization_normalization: true,
            phone_normalization: true,
            replace_remaining_symbols: true
        },
        customPronunciations: {}
    });

    let backend;
    let apiUrl;
    try {
        ({ backend, apiUrl } = TtsProviders.resolvePlaybackConnection(
            settings.ttsBackend, settings.apiUrl));
    } catch (error) {
        notify('Kokoro TTS Error', error.message);
        return;
    }
    // Both local engines run in the extension-owned audio player. Selected
    // text stays local; do not probe FastAPI or request server audio.

    // The shared resolver strips the server URL for both local providers.
    // Preserve the existing overlay behavior in download mode until local
    // full-selection export is implemented; saving in the player exports WAV.
    if (backend !== TtsProviders.FASTAPI && settings.mode === 'download' && !isArticleMode) {
        notify('Kokoro TTS',
            'Local download opens the player. Use Save audio there to download a WAV sentence.');
    }

    // Network connectivity matters only for the explicitly selected server backend.
    // Toolbar paint stays with checkApiStatus so a mid-flight backend switch cannot
    // be overwritten by a late /models success (#208).
    if (backend === TtsProviders.FASTAPI) {
        try {
            const statusUrl = new URL('models', apiUrl).href;
            const statusResp = await fetch(statusUrl);
            if (!statusResp.ok) {
                console.warn("Status check returned " + statusResp.status);
            }
            void checkApiStatus();
        } catch (e) {
            void checkApiStatus();
            notify("Kokoro TTS Error", `Could not connect to Kokoro API at ${apiUrl}. Is it running?`);
            return;
        }
    }

    try {
        if (backend === TtsProviders.FASTAPI && settings.mode === 'download' && !isArticleMode) {
            const endpoint = new URL('audio/speech', apiUrl).href;
            const body = {
                model: 'kokoro',
                input: text,
                voice: settings.voice,
                response_format: 'mp3',
                normalization_options: settings.normalizationOptions
            };
            notify("Kokoro TTS", "Generating audio...");
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errText = await response.text();
                notify("Kokoro TTS Error", "API Error: " + response.status + " " + errText);
                return;
            }

            const blob = await response.blob();
            const filename = sanitizeFilename(tab.title || "audio") + ".mp3";

            if (typeof browser.downloads === 'undefined') {
                console.error("Downloads API not available");
                notify("Kokoro TTS Error", "Downloads API is unavailable.");
                return;
            }
            try {
                await downloadFastApiMp3(blob, filename);
            } catch (downloadError) {
                notify("Kokoro TTS Error",
                    "Download failed: " + (downloadError?.message || downloadError));
                return;
            }

        } else {
            // Stream mode: Trigger overlay in the content script
            await browser.storage.local.set({
                pendingText: text,
                pendingContent: structuredContent || [{ type: 'text', content: text }],
                pendingVoice: settings.voice,
                pendingApiUrl: apiUrl,
                pendingTtsBackend: backend,
                pendingMediaPipeVariant: settings.mediaPipeVariant,
                pendingLocalVoice: LocalVoice.mediaPipeVoiceFromSettings(settings),
                pendingOnnxVoiceAsset: LocalVoice.onnxVoiceAssetFromSettings(settings),
                pendingTitle: tab.title,
                pendingNormalizationOptions: settings.normalizationOptions,
                pendingCustomPronunciations: settings.customPronunciations,
                pendingAutoplay: true
            });

            // Send message to the active tab to show the overlay
            try {
                await browser.tabs.sendMessage(tab.id, {
                    action: "SHOW_PLAYER",
                    mode: isArticleMode ? 'full' : 'popup'
                });
            } catch (err) {
                // Retry injection
                console.log("Show player failed, trying to inject...", err);
                try {
                    await ensureContentScript(tab.id);
                    await browser.tabs.sendMessage(tab.id, {
                        action: "SHOW_PLAYER",
                        mode: isArticleMode ? 'full' : 'popup'
                    });
                } catch (finalErr) {
                    notify("Kokoro TTS Error", "Could not open player. Try refreshing the page.");
                    console.error(finalErr);
                }
            }
        }

    } catch (e) {
        checkApiStatus();
        let msg = e.message;
        if (msg === "Failed to fetch") {
            msg = `Connection failed. Is Kokoro-FastAPI running on ${apiUrl}?`;
        }
        notify("Kokoro TTS Error", "Generation failed: " + msg);
    }
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "send-to-kokoro" || info.menuItemId === "read-article-kokoro") {
        await handleTtsAction(tab, info.menuItemId, info.selectionText);
    }
});

browser.runtime.onMessage.addListener(async (request, sender) => {
    if (request.action === "REQUEST_TTS" && request.text) {
        if (sender.tab) {
            await handleTtsAction(sender.tab, "send-to-kokoro", request.text);
        }
    } else if (request.action === "GET_TTS_BACKEND_CAPABILITIES") {
        // Read-only metadata must never probe FastAPI or download/load a model.
        // Real availability belongs to each runtime's status() path.
        try {
            return {
                success: true,
                capabilities: request.backend === undefined
                    ? TtsProviders.listCapabilities()
                    : [TtsProviders.getCapabilities(request.backend)],
            };
        } catch (error) {
            return { success: false, kind: 'invalid-backend', error: error.message };
        }
    } else if (request.action === "FETCH_TTS_AUDIO") {
        try {
            const selected = await browser.storage.sync.get({ ttsBackend: TtsProviders.FASTAPI });
            const selectedBackend = TtsProviders.resolveBackend(selected.ttsBackend);
            const requestedBackend = TtsProviders.resolveBackend(request.backend);
            if (selectedBackend !== TtsProviders.FASTAPI || requestedBackend !== TtsProviders.FASTAPI) {
                return TtsProviders.unavailableResponse(
                    selectedBackend !== TtsProviders.FASTAPI ? selectedBackend : requestedBackend
                );
            }
            const started = performance.now();
            const response = await fetch(request.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request.payload)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`API Error: ${response.status} ${errText}`);
            }

            // Stream the body so firstBodyByteMs is time-to-first-byte, not
            // full-buffer completion. This is TTFB, not decoded/playable TTFA.
            const { dataUrl, firstBodyByteMs } =
                await readTtsResponseAsDataUrl(response, started);
            return { success: true, dataUrl, firstBodyByteMs };

        } catch (e) {
            console.error("Background fetch failed:", e);
            return { success: false, error: e.message };
        }
    }
});


function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * Prefer a real body stream so firstBodyByteMs is time-to-first-byte from
 * `started`. Fall back to blob() without inventing a first-byte value.
 * Callers must not label this as decoded/playable TTFA.
 */
async function readTtsResponseAsDataUrl(response, started) {
    const type = response.headers?.get?.('Content-Type') || 'audio/mpeg';
    const stream = response.body;
    if (stream && typeof stream.getReader === 'function') {
        const reader = stream.getReader();
        const chunks = [];
        let firstBodyByteMs = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
                if (firstBodyByteMs === null) {
                    firstBodyByteMs = performance.now() - started;
                }
                chunks.push(value);
            }
        }
        const blob = new Blob(chunks, { type });
        return { dataUrl: await blobToDataUrl(blob), firstBodyByteMs };
    }
    const blob = await response.blob();
    return { dataUrl: await blobToDataUrl(blob), firstBodyByteMs: null };
}

function prefersBlobDownloadUrl() {
    // Firefox accepts blob: from the background script. Chromium MV3 service
    // workers expose createObjectURL, but downloads.download rejects blob: —
    // use a data: URL there instead (live dual: Chromium needs data:, Firefox
    // needs blob:; always-data: failed Firefox download honor).
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    return /firefox/i.test(ua) && typeof URL.createObjectURL === 'function';
}

async function downloadFastApiMp3(blob, filename) {
    // Chromium SW: data: URL. Firefox: blob: — but downloads.download resolves
    // when the download *starts*, so keep the blob pinned until onChanged
    // reports complete/interrupted (same pattern as overlay downloadPinnedSentence).
    if (!prefersBlobDownloadUrl()) {
        const dataUrl = await blobToDataUrl(blob);
        await browser.downloads.download({
            url: dataUrl,
            filename: filename,
            saveAs: false
        });
        return;
    }
    const url = URL.createObjectURL(blob);
    const release = () => {
        try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    };
    const events = browser.downloads.onChanged;
    if (!events?.addListener || !events?.removeListener) {
        try {
            await browser.downloads.download({
                url: url, filename: filename, saveAs: false,
            });
        } finally {
            release();
        }
        return;
    }
    let downloadId = null;
    let finished = false;
    const earlyTerminals = new Set();
    const finish = () => {
        if (finished) return;
        finished = true;
        events.removeListener(onChanged);
        release();
    };
    const onChanged = delta => {
        if (!['complete', 'interrupted'].includes(delta.state?.current)) return;
        if (downloadId === null) earlyTerminals.add(delta.id);
        else if (delta.id === downloadId) finish();
    };
    try {
        events.addListener(onChanged);
        downloadId = await browser.downloads.download({
            url: url, filename: filename, saveAs: false,
        });
        if (earlyTerminals.has(downloadId)) finish();
    } catch (error) {
        finish();
        throw error;
    }
}

// Do not confuse an ordinary website's /reader.html with our extension tab.
function isReaderTabUrl(url) {
    const readerUrl = browser.runtime.getURL('reader.html');
    return typeof url === 'string' &&
        (url === readerUrl || url.startsWith(readerUrl + '?') || url.startsWith(readerUrl + '#'));
}

async function activeTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
}

async function handleReadArticleShortcut() {
    const tab = await activeTab();
    if (!tab) return;
    if (isReaderTabUrl(tab.url || '')) {
        console.log("Shortcut disabled on reader page.");
        return;
    }
    try {
        const response = await browser.tabs.sendMessage(tab.id, { action: "CHECK_PLAYER_ACTIVE" });
        if (response && response.active) {
            console.log("Player already active, ignoring shortcut.");
            return;
        }
    } catch (e) {
        // Content script might not be there or ready, proceed to try opening
    }
    // Clear stale pending text to prevent "echo"
    await browser.storage.local.remove(['pendingText', 'pendingContent', 'pendingVoice']);
    await handleTtsAction(tab, "read-article");
}

async function handleNavShortcut(command) {
    const tab = await activeTab();
    if (!tab) return;
    const direction = command === "nav-next" ? "NAV_NEXT" : "NAV_PREV";
    if (isReaderTabUrl(tab.url)) {
        // Extension reader pages have no content script. Broadcast within
        // the extension; each reader checks its own tab ID before forwarding.
        try {
            await browser.runtime.sendMessage({
                action: 'KOKORO_READER_NAV', tabId: tab.id, direction,
            });
        } catch (err) {
            console.log("Reader navigation shortcut unavailable:", err);
        }
        return;
    }
    browser.tabs.sendMessage(tab.id, { action: direction }).catch(err => {
        // Preserve existing webpage overlay navigation.
        console.log("Navigation command failed (player might be closed):", err);
    });
}

async function handleCloseOverlayShortcut() {
    const tab = await activeTab();
    if (!tab) return;
    browser.tabs.sendMessage(tab.id, { action: "REMOVE_PLAYER" }).catch(() => { });
}

browser.commands.onCommand.addListener(async (command) => {
    if (command === "read-article") return handleReadArticleShortcut();
    if (command === "open-reader") return browser.tabs.create({ url: 'reader.html' });
    if (command === "nav-next" || command === "nav-prev") return handleNavShortcut(command);
    if (command === "close-overlay") return handleCloseOverlayShortcut();
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        checkApiStatus,
        applyToolbarStatus,
        probeLocalToolbarStatus,
        probeFastApiToolbarStatus,
        syncToolbarAlarm,
        ToolbarStatus,
    };
}
