try {
    if (typeof importScripts === 'function') {
        importScripts('browser-polyfill.min.js');
    }
} catch (e) {
    console.error("Polyfill load error:", e);
}

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

// Icon management
const setIconStatus = (isConnected) => {
    const suffix = isConnected ? '-green' : '-red';
    browser.action.setIcon({
        path: {
            48: `icons/icon-48${suffix}.png`,
            128: `icons/icon-128${suffix}.png`
        }
    });
};

const checkApiStatus = async () => {
    if (isChecking) return;
    isChecking = true;

    try {
        const settings = await browser.storage.sync.get({
            apiUrl: 'http://127.0.0.1:8880/v1/'
        });

        let apiUrl = settings.apiUrl;
        if (!apiUrl.endsWith('/')) apiUrl += '/';

        // Helper to try fetch with timeout
        const tryFetch = async (url) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            try {
                const response = await fetch(url, { signal: controller.signal });
                return response;
            } finally {
                clearTimeout(timeoutId);
            }
        };

        // Check 1: /v1/test (kokoro-fastapi specific)
        let connected = false;

        try {
            const testUrl = new URL('test', apiUrl).href;
            const resp = await tryFetch(testUrl);
            if (resp.ok) {
                const json = await resp.json();
                if (json.status === 'ok') {
                    connected = true;
                }
            }
        } catch (e) {
            // ignore
        }

        // If not yet connected, try /health
        if (!connected) {
            try {
                const urlObj = new URL(apiUrl);
                const healthUrl = new URL('/health', urlObj.origin).href;

                const resp = await tryFetch(healthUrl);
                if (resp.ok) {
                    const json = await resp.json();
                    if (json.status === 'healthy') {
                        connected = true;
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        setIconStatus(connected);

    } catch (e) {
        console.error("API check failed completely:", e);
        setIconStatus(false);
    } finally {
        isChecking = false;
    }
};

// Initial check
checkApiStatus();

// Poll every minute
browser.alarms.create('api-check', { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'api-check') {
        checkApiStatus();
    }
});

// Update on settings change
browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.apiUrl) {
        checkApiStatus();
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
                files: ['browser-polyfill.min.js', 'readability.js', 'content.js']
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

    let apiUrl = settings.apiUrl;
    if (!apiUrl.endsWith('/')) apiUrl += '/';

    // Check status
    try {
        const statusUrl = new URL('models', apiUrl).href;
        const statusResp = await fetch(statusUrl);
        if (!statusResp.ok) {
            console.warn("Status check returned " + statusResp.status);
        } else {
            setIconStatus(true);
        }
    } catch (e) {
        checkApiStatus();
        notify("Kokoro TTS Error", `Could not connect to Kokoro API at ${apiUrl}. Is it running?`);
        return;
    }

    // Prepare request
    const endpoint = new URL('audio/speech', apiUrl).href;
    const body = {
        model: 'kokoro',
        input: text,
        voice: settings.voice,
        response_format: 'mp3',
        normalization_options: settings.normalizationOptions
    };

    try {
        if (settings.mode === 'download' && !isArticleMode) {
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

            let url;
            // Check if URL.createObjectURL is available (Firefox / Background Pages)
            if (typeof URL.createObjectURL === 'function') {
                url = URL.createObjectURL(blob);
            } else {
                // Fallback for Chrome Service Workers (Data URL)
                const blobToDataURL = (blob) => {
                    return new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                };
                url = await blobToDataURL(blob);
            }

            if (typeof browser.downloads !== 'undefined') {
                browser.downloads.download({
                    url: url,
                    filename: filename,
                    saveAs: false
                });
            } else {
                console.error("Downloads API not available");
            }

        } else {
            // Stream mode: Trigger overlay in the content script
            await browser.storage.local.set({
                pendingText: text,
                pendingContent: structuredContent || [{ type: 'text', content: text }],
                pendingVoice: settings.voice,
                pendingApiUrl: apiUrl,
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
    }
});


browser.commands.onCommand.addListener(async (command) => {
    if (command === "read-article") {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs[0]) {
            const url = tabs[0].url || "";
            if (url.includes('reader.html') || url.startsWith('extension://') && url.includes('reader.html')) {
                console.log("Shortcut disabled on reader page.");
                return;
            }
            const tabId = tabs[0].id;

            // Check if player is already active
            try {
                const response = await browser.tabs.sendMessage(tabId, { action: "CHECK_PLAYER_ACTIVE" });
                if (response && response.active) {
                    console.log("Player already active, ignoring shortcut.");
                    return;
                }
            } catch (e) {
                // Content script might not be there or ready, proceed to try opening
            }

            // Clear stale pending text to prevent "echo"
            await browser.storage.local.remove(['pendingText', 'pendingContent', 'pendingVoice']);

            // Proceed with full TTS action (article extraction, etc.)
            await handleTtsAction(tabs[0], "read-article");
        }
    } else if (command === "open-reader") {
        browser.tabs.create({ url: 'reader.html' });
    } else if (command === "nav-next" || command === "nav-prev") {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs[0]) {
            browser.tabs.sendMessage(tabs[0].id, {
                action: command === "nav-next" ? "NAV_NEXT" : "NAV_PREV"
            }).catch(err => {
                // Command might be sent while player is not open
                console.log("Navigation command failed (player might be closed):", err);
            });
        }
    } else if (command === "close-overlay") {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs[0]) {
            browser.tabs.sendMessage(tabs[0].id, { action: "REMOVE_PLAYER" }).catch(() => { });
        }
    }
});
