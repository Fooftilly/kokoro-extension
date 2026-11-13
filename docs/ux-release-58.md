# UX and release — three backends (#58)

## What this issue closed on tip

Most of the three-backend stack already landed in earlier slices (#54 routing, #55/#61 downloads/test page, #56/#60 providers, #59 voice prefs). This #58 PR focuses on remaining **UX honesty and docs**:

- Popup radios restyled as cards with compact meta (server / MediaPipe / ONNX).
- Prominent **Test TTS backends** CTA (+ hint) opening `benchmark.html`.
- Backend disclosure copy: privacy (local never hits FastAPI), local WAV / single-voice vs remote MP3 / weighted mix, ONNX = packaged WASM CPU, MediaPipe CPU may be slower than real-time, MediaPipe GPU labeled experimental/unverified.
- Download footprint notes: model+voice download size vs packaged tokenizer/runtime; CMUdict separate; GPU unverified until adapter + successful test.
- Docs/README/AGENTS sync so local backends are not described as unimplemented.

## Explicitly out of scope here

- Editing `.github/workflows/live-browser-acceptance.yml` or other #146 live-acceptance harnesses.
- Claiming MediaPipe GPU or ONNX WebGPU as product-supported.
- Shipping fp32 ONNX or embedding the full download manager inside the popup.

## Manual Chrome / Firefox UX smoke (unpacked `dist/*`)

Do **not** rely on jsdom alone for this checklist:

1. Load `dist/chrome` and `dist/firefox` unpacked.
2. Popup shows three backend cards; FastAPI default for a fresh profile.
3. **Test TTS backends** opens the extension test page; install MediaPipe CPU and/or ONNX q8 + CMUdict with explicit Download clicks.
4. **Use this backend** updates preference only after confirmation; popup radios reflect the choice.
5. Selection / article / EPUB playback with local backend produces local audio and does not call FastAPI speech endpoints (DevTools network).
6. Disconnect network after models are cached; local playback still works; FastAPI mode fails closed without sending unexpected traffic.
7. Confirm MediaPipe GPU row discloses unverified status; GPU test refuses without a WebGPU adapter.
8. After extension restart, installed models and backend choice still work.

CPU validation evidence: `docs/runtime-validation-2026-11-07.md`.
