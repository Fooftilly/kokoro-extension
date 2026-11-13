# Three-backend routing foundation (#54) and UX (#58)

Backend setting: `browser.storage.sync.ttsBackend` = `fastapi` | `mediapipe` | `onnx`. A missing value maps to `fastapi` for existing users. Any unknown explicit value fails closed rather than silently transmitting text to the server.

The popup offers three explicit choices (server / MediaPipe / ONNX). Independent preferences are preserved when switching (#59): FastAPI weighted `voice`, MediaPipe `mediaPipeVoice`, and fixed ONNX `onnxVoiceAsset`. Local modes never send speech text to FastAPI and never fall back to the server.

When a local provider is selected, the background does not poll the API, issue HTTP requests for selected text, or forward stale `FETCH_TTS_AUDIO` messages to FastAPI. The reader and audio player carry the selection as `pendingTtsBackend`.

Chrome's background service worker imports `tts-providers.js` and `local-voice-mixing.js`. Firefox loads those same classic scripts before `background.js` through `background.scripts` (`browser-polyfill.min.js`, `tts-providers.js`, `local-voice-mixing.js`, `background.js`). The shared registries are also CommonJS-loadable by Jest.

Model downloads, provenance, and “Use this backend” live on the extension-owned TTS test page (`benchmark.html` / #61), opened from the popup **Test TTS backends** button. Preference updates only after an explicit user action on that page.

See `docs/ux-release-58.md` for the UX/release checklist and Chrome/Firefox offline notes.
