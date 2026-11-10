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

Both opt-in live browser harnesses first require the UI to show **Installed**,
then deliberately evict the dictionary and click **Recheck installed models**.
The row must display **Cached model data is missing** with Remove disabled.
Only after this visible transition do they explicitly repair the dictionary
through the harness data-store API. A second
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


The Firefox harness installs its network guard on the actual page window
(using the Marionette page wrapper when present), because each Selenium
script executes in a separate sandbox. It restores the original fetch
function after the UI assertions, before beginning offline inference.

## Chromium model-manager dictionary Download/Cancel/Retry acceptance (#55)

The manual-only Chromium workflow now explicitly clicks the packaged
extension's **Download** button on the dictionary row, requests the normal
narrow optional official-host permission, and intercepts just that dictionary
fetch with an abort-aware stalled response. It clicks the **Cancel download**
button, checks that the status and controls recover and the cache is empty,
then retries by clicking **Download** again with the real pinned HTTPS fetch
restored. It requires a single real asset fetch, the exact full manifest byte
count in Cache Storage, actual SHA-256 verification, a completed 100% progress
indicator, and the real Remove button clearing the data. This is reported as
`dictionaryUiDownloadAcceptance` with separate failure diagnostics.

This is an opt-in browser acceptance script, **not evidence of a passing real
browser run** until manually executed. The artificial stall is used only for
repeatable cancellation; the retry downloads the authentic pinned dictionary.
Firefox Download/Cancel/Retry UI and real heavyweight model-host transfers
remain separate gates. Browser native host-permission prompt behavior must be
confirmed during actual run, not inferred from unit tests.

### Lightweight manual execution

For the Chromium dictionary-only UI path, dispatch the **Real Kokoro MV3 model
acceptance** workflow with `acceptance_scope: chromium-dictionary`. This
explicitly skips ONNX/MediaPipe weight downloads and both Firefox matrix jobs;
it still packages the extension, runs Chromium preflight, verifies the real
pinned dictionary URL and SHA-256, restarts its persistent browser profile,
tests simulated eviction/recovery, and exercises the real Download/Cancel/Retry/
Remove buttons. The normal `full` dispatch retains all heavy model-backed
Chromium and Firefox acceptance jobs. Neither choice runs automatically on
ordinary PRs or pushes to master.

Direct local invocation can instead set `KOKORO_LIVE_PROVIDER=dictionary`
alongside the existing explicit live-download flag and pinned Playwright
module path. A dictionary-only pass is **not** evidence of offline TTS
inference: the reported `providerFilter` and `scope` identify that limitation.

### Firefox dictionary Download/Cancel/Retry controls

An explicit manual `acceptance_scope: firefox-dictionary` workflow dispatch
packages a temporary Firefox extension and runs only pinned CMUdict smoke
checks; it skips Chrome and heavyweight ONNX/MediaPipe models. The Firefox
harness also supports `KOKORO_FIREFOX_PROVIDER=dictionary` in local opt-in
runs. After the existing pinned HTTPS integrity, page-reload persistence and
eviction checks, it clicks the actual Download button, intercepts only the
dictionary request with an abort-aware stalled fetch, clicks Cancel, checks
that no bytes remain, and retries via the real HTTPS origin. It requires
exactly one official-host fetch, narrow optional host permission, full
manifest byte count in Cache Storage, SHA-256 integrity, 100% displayed
progress, and real UI Remove clearing the cached entry.

In Firefox the fetch guard is exported to the actual extension-page window
so Selenium's per-call Marionette sandbox does not hide fetch counts. The
report records `dictionaryUiDownloadAcceptance` separately, with
`offlineAttempted: false` for dictionary-only runs. A headless optional
host-permission dialog may block permission approval; the acceptance run
must **fail visibly** rather than silently bypass user consent or claim
success. Manual real-browser execution is still required.


## Chromium MediaPipe official-host origin download (#55)

Dispatch **Real Kokoro MV3 model acceptance** with
`acceptance_scope: chromium-mediapipe-origin`. This is an explicit,
heavyweight, manual-only run; normal PR CI and the default `full` workflow
keep their existing authenticated-loopback model preload. This origin mode
downloads **only MediaPipe CPU** from its pinned official HTTPS model URL,
through the packaged extension's actual Download control after its optional
host-permission request. It does not bypass denied permission or grant
permissions silently. The independent Firefox and ONNX jobs are not run.

Before the click the harness explicitly clears any prior MediaPipe CPU cached
assets, reloads the model-manager page, and requires a ready Download control
with a Not installed status. It counts **streamed response bytes** for each
pinned URL, rejects any unexpected HTTP(S) request, checks exactly one fetch
per pinned asset, confirms the UI reaches 100%, and verifies all stored assets
against pinned SHA-256 and byte counts. The completed cache is then used by
the existing **network-offline** MediaPipe CPU initialization/synthesis probe
and Chromium browser-restart persistence checks. The attached
`report.json` identifies this mode via `originDownload: true` and records
`originModelAcceptance` with transferred bytes, cache bytes, permission,
asset requests, and verification. No weights enter the repository.

This harness is an **acceptance implementation, not a passing test report**:
a manual run must supply evidence of actual browser/host behavior, including
whether headless Chromium can present or approve the optional permission.
It does not establish ONNX or Firefox origin-download acceptance, real
quota eviction, subjective speech quality, or native permission-dialog UX.
