try {
    importScripts('browser-polyfill.min.js');
} catch (e) {
    console.error(e);
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

browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "send-to-kokoro" || info.menuItemId === "read-article-kokoro") {
        let text = "";

        if (info.menuItemId === "read-article-kokoro") {
            // We need to ask the content script to parse the page
            try {
                const response = await browser.tabs.sendMessage(tab.id, { action: "PARSE_ARTICLE" });
                if (response && response.text) {
                    text = response.text;
                    // Store the structured content temporarily
                    info._structuredContent = response.content;
                } else {
                    notify("Kokoro TTS", "Could not extract article text.");
                    return;
                }
            } catch (e) {
                notify("Kokoro TTS Error", "Reload the page to use this feature.");
                return;
            }
        } else {
            text = info.selectionText;
        }

        if (!text) return;

        // Get settings
        const settings = await browser.storage.sync.get({
            apiUrl: 'http://127.0.0.1:8880/v1/',
            voice: 'af_heart(10)+af_bella(7.5)+af_jessica(2.5)',
            mode: 'download'
        });

        let apiUrl = settings.apiUrl;
        if (!apiUrl.endsWith('/')) apiUrl += '/';

        // Check status
        try {
            const statusUrl = new URL('models', apiUrl).href;
            const statusResp = await fetch(statusUrl);
            if (!statusResp.ok) {
                console.warn("Status check returned " + statusResp.status);
            }
        } catch (e) {
            notify("Kokoro TTS Error", "Could not connect to Kokoro API. Is it running?");
            return;
        }

        // Prepare request
        const endpoint = new URL('audio/speech', apiUrl).href;
        const body = {
            model: 'kokoro',
            input: text,
            voice: settings.voice,
            response_format: 'mp3'
        };

        try {
            // Force stream/overlay mode if it's the "Read Article" action
            const isArticleMode = info.menuItemId === "read-article-kokoro";

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

                // browser.downloads might need permissions, but polyfill maps it correctly.
                // Note: browser.downloads is not available in all contexts in Firefox without permission,
                // but we added "downloads" permission.
                if (typeof browser.downloads !== 'undefined') {
                    browser.downloads.download({
                        url: url,
                        filename: filename,
                        saveAs: false
                    });
                } else {
                    // Fallback?? Or just notify error.
                    // downloads API is standard for extensions.
                    console.error("Downloads API not available");
                }

            } else {
                // Stream mode: Trigger overlay in the content script
                await browser.storage.local.set({
                    pendingText: text,
                    pendingContent: info._structuredContent || [{ type: 'text', content: text }],
                    pendingVoice: settings.voice,
                    pendingApiUrl: apiUrl,
                    pendingTitle: tab.title
                });

                // Send message to the active tab to show the overlay
                try {
                    await browser.tabs.sendMessage(tab.id, {
                        action: "SHOW_PLAYER",
                        mode: isArticleMode ? 'full' : 'popup'
                    });
                } catch (err) {
                    notify("Kokoro TTS Error", "Could not open player. Try refreshing the page.");
                    console.error(err);
                }
            }

        } catch (e) {
            notify("Kokoro TTS Error", "Generation failed: " + e.message);
        }
    }
});
