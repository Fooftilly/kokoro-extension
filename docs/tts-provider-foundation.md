# Three-backend routing foundation (#54)

This slice introduces three stable backend IDs and fail-closed server routing guards, not actual local inference or a user-facing on-device switch. Current installations continue to use Kokoro-FastAPI by default. MediaPipe and ONNX are reserved independently for #56 and #60. The model download manager and backend selector will arrive in #55 and #58.

Backend setting: browser.storage.sync ttsBackend = fastapi | mediapipe | onnx. A missing value maps to fastapi for existing users. Any unknown explicit value fails closed rather than silently transmitting text to the server.

The existing FastAPI selection, article actions and EPUB playback are unchanged. When a local provider is selected in storage, the background does not poll the API, issue HTTP requests for selected text, or forward stale FETCH_TTS_AUDIO messages to FastAPI. The reader and audio player carry the selection as pendingTtsBackend.

Chrome's background service worker imports tts-providers.js. Firefox loads that same classic script before background.js through background.scripts. The shared registry is also CommonJS-loadable by Jest. No new network permissions or CSP exceptions are needed. The Chrome/Firefox manifest and CI assertions account for the new Firefox background script.

A backend picker is intentionally not shown yet: presenting local modes as working before the actual SDK/model integration would mislead users. #58 will add a three-way visible choice, install states and capability labels when the engines are usable.

Manual browser verification after integration: confirm Firefox script ordering, FastAPI default settings and existing voice mixing/downloads, no TTS network requests in local modes, and correct selection propagation through reader/overlay.
