# On-device Kokoro browser validation — stage 1 (#53)

Status: **preflight only; NOT an inference benchmark**. No backend/model has been executed or proven compatible in Chrome/Firefox in this PR.

## How to run
1. Run npm ci, npm test, npm run lint, and npm run package in this repository.
2. Load dist/chrome in Chrome or dist/firefox in Firefox as a temporary extension.
3. Open the popup and click **Check browser TTS capabilities**.
4. Select **Check browser support**, then optionally **Copy local report**. The preflight makes zero requests and does not download model weights.
5. Record browser version, OS, extension mode, GPU/driver, secureContext, crossOriginIsolated, wasmCompilation, wasmThreadsPrerequisites, and webgpu.status. Browser conditions differ between extension contexts and normal web pages.

The WebAssembly check compiles an eight-byte, valid empty WASM module in the **actual extension page**. Chrome's current extension-page CSP (`script-src 'self'` without `wasm-unsafe-eval`) can prevent compilation even when the `WebAssembly.compile` API exists. Such a rejection correctly reports `wasmCompilation: false` and `wasmThreadsPrerequisites: false`. When the official inference runtimes are integrated, review the minimum necessary CSP change separately.

A WebGPU adapter does **not** establish ONNX graph support or MediaPipe GPU compatibility. WASM compilation does **not** establish the Kokoro model's memory/CPU feasibility. Do not classify either backend as working until it produces validated audio inside both packaged extensions.

## Next stage — verified real inference (#53, #56, #60)
- Use only official @mediapipe/tasks-audio v1.2.2+ and onnxruntime-web, not implementation code from other Kokoro JS projects.
- Pin SDK versions and exact model revisions, hash model/voice data, locally package all executable JS/WASM. Model/voice data may be downloaded only on explicit user action.
- MediaPipe: test Kokoro .litertlm CPU and GPU delegates, streamed 24-kHz PCM, voice enumeration and cancellation. The approximate 295 MB weight file is a model-only estimate.
- ONNX Runtime Web: test official Kokoro ONNX quantized model with a correctly implemented original text-to-phoneme frontend, voice style embedding, model inputs (input_ids, style, speed), 24-kHz PCM; check GPU only on known-compatible browsers/hardware. The 86/92.4/326 MB model sizes exclude voice/config/phonemization assets.
- Test actual Firefox and Chrome extension contexts, 1-thread WASM and multi-thread only when properly isolated, and correct output waveforms. WebGPU can be absent, fail adapter allocation or lack required operators.
- Record real download bytes, cold/warm init time, first playable audio, total synthesis duration, audio duration, RTF, peak memory/CPU/GPU when measurable, audible quality and playback gaps, with 3+ repeat runs for p50/p95.
- Keep cold and warm results separate; do not compare one cached local path with cold remote network results as if equivalent.
- Do not mark #53 complete until model-backed Chrome/Firefox results are committed.

## Official sources
- MediaPipe browser guide: https://developers.google.com/edge/mediapipe/solutions/audio/text_to_speech/web_js
- MediaPipe API: https://developers.google.com/edge/api/mediapipe/js/tasks-audio.texttospeech
- ONNX Runtime Web: https://onnxruntime.ai/docs/get-started/with-javascript/web.html
- ONNX runtime asset packaging: https://onnxruntime.ai/docs/tutorials/web/deploy.html
- Original Kokoro ONNX model interface: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX

No source code from those projects is copied into this extension by this PR.


## Strict offline inference acceptance — follow-up to #55

The opt-in real-browser harnesses now explicitly switch the browser offline
**after** transferring checksum-verified pinned assets into the extension's
Cache Storage, and **before** constructing the MediaPipe or ONNX inference
session. They check offline state and require playable, finite, non-silent PCM
from locally packaged SDK/WASM in the extension origin. Chromium restores
connectivity between separate provider runs solely to preload the next model;
any optional failure diagnostics are clearly reported as outside offline
acceptance. Firefox remains offline until its isolated temporary browser process is closed.

The manual-only GitHub Actions workflow tests Chromium and separate Firefox
ONNX/MediaPipe CPU sessions, attaching browser reports. It intentionally
does **not** run on ordinary master pushes or PRs because the live models are
large. CI only syntax-checks the harnesses. The tests still use a runner-side
authenticated loopback transfer of pinned model bytes: they **do not** yet
exercise the actual Download/Cancel/Retry/Remove UI, upstream fetch CORS/SRI,
real Firefox browser-restart persistence, browser-managed storage eviction,
quota behavior, or user-perceived audio quality. Those remain separate #55
acceptance gates; the Chromium restart test below is manual-only and has
not yet been executed.


## Direct pinned-asset browser download smoke test (#55)

The manual-only Chromium and Firefox acceptance harnesses now separately call
the production `ModelDataStore.install()` using the official immutable CMUdict
HTTPS URL (3,618,488 bytes). They verify browser CORS/SRI handling, the actual
stored SHA-256, progress reaching the pinned byte count, a second install
reusing the cached entry **without another network fetch**, and explicit
removal. The test deliberately clears only the dedicated dictionary cache
entry first and never downloads speech models automatically. It runs before
the normal heavy-model cache-preload/offline-inference stages.

This validates the data-store API in packaged browser contexts, not user
gestures or the model-manager Download/Remove controls. Live workflow
execution remains necessary; ordinary PR CI only syntax-checks these harnesses.
The new opt-in tests cover a Chromium process restart and page reload in
Firefox, plus simulated dictionary eviction. Genuine Firefox process restart,
browser-managed quota eviction, full model downloads through official host
permissions, cancellation UI, and user-facing progress still require acceptance.


## Persistence and simulated eviction acceptance (#55)

The manual-only Chromium harness now keeps a verified official dictionary in
Cache Storage until it shuts down the **actual Chromium browser process** and
starts a new persistent context using the same profile and unpacked extension.
With network access disabled, it verifies the extension ID did not change,
checks that all previously populated model entries are still present (fast
metadata-only status), and verifies the dictionary's actual SHA-256. It then
simulates storage eviction of the dictionary, checks that missing data is
detected without any automatic network access, explicitly re-downloads and
verifies only that dictionary, and finally removes it. The result is recorded
as `browserRestartAcceptance` in the report. Model weight byte-for-byte
integrity after restart is **not** established by these metadata-only checks.

Firefox's live harness uses a **temporary** add-on, which is not retained
across browser-process restart. It therefore verifies the dictionary after
reloading the extension page within the same Firefox process, then exercises
the same simulated eviction/explicit SHA-256 repair/removal sequence. It reports
`dictionaryReloadAcceptance.browserProcessRestarted: false` to avoid conflating
page reload with a true restart. Genuine Firefox browser-restart persistence,
model-manager UI interactions, actual browser quota eviction, and full-model
direct host-permission downloads still need their own acceptance runs.

The cache-eviction step deletes a known test entry deliberately; this checks
recovery logic but **does not** simulate the browser's automatic quota-driven
eviction heuristics. Neither script runs in normal PR CI or downloads real
weights without the explicit manual live-acceptance workflow.


## Real model-manager button acceptance (part of #55)

Both opt-in live browser harnesses first click **Recheck installed
models** with the dictionary deliberately evicted and require the real row
to show **Not installed**. Only after this visible missing state do they
explicitly repair the dictionary through the harness data-store API. A second
Recheck must transition the row to **Installed**, after which the harness
clicks the actual **Remove** button and confirms the row says Not installed
with Download available and no dictionary bytes left in Cache Storage.
The harness instruments the real page global fetch used by the manager's
button handlers and fails if either action requests additional model data. Chromium runs this after its true browser restart; Firefox runs it
after its fresh extension-page reload. Results include
`modelManagerRecheckClicked`, `modelManagerRemoveClicked`,
`uiEvictionObservedBeforeRepair`, `noUiModelFetches`, and
`uiRemovalVerifiedInCache`.

These tests do not yet exercise the Download, Cancel, or Retry UI buttons or
optional host-permission prompt (the dictionary is installed by an explicit
test-harness data-store operation). No live-browser result is claimed until
the manually dispatched workflow has actually passed.
