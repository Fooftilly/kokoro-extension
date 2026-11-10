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


## Chromium ONNX q8 official-host origin download (#55)

Choose `acceptance_scope: chromium-onnx-origin` in the manual **Real Kokoro MV3
model acceptance** workflow (or use `KOKORO_LIVE_DOWNLOAD=1`,
`KOKORO_LIVE_PROVIDER=onnx` and
`KOKORO_CHROMIUM_ORIGIN_DOWNLOAD=1` with an explicitly pinned Playwright
module). This runs the production extension's ONNX q8 **Download** button,
including its permission request, against the two pinned Hugging Face assets:
the quantized ONNX graph and the af voice embedding. The packaged tokenizer
is not downloaded. The separate official pinned CMUdict asset is downloaded,
hashed, and retained by the existing dictionary preflight, not silently
requested by ONNX installation.

The run clears only the selected ONNX q8 cache entries, requires Not installed
before clicking Download, measures actual response-stream bytes per pinned
asset URL, rejects any unexpected HTTP(S) request, verifies exact cumulative
byte count and SHA-256 for both ONNX assets, and requires the actual UI to
display the manifest total and reach 100%. The test also checks full dictionary
integrity and confirms the preexisting MediaPipe CPU/GPU cache status is
unchanged across the ONNX installation. It then performs the existing
**network-offline** ONNX synthesis checks, including English dictionary
synthesis, and browser-restart cache persistence checks.

The resulting `report.json` has `providerFilter: "onnx"`,
`originDownload: true` and an `originModelAcceptance` object with expected,
transferred and cached bytes, actual asset requests, permission, integrity,
dictionary and cross-provider status. No model weights or new permissions are
added to the extension or ordinary CI.

This mode must be **run manually** before claiming passing real-browser
acceptance. In particular, headless optional permission prompts may prevent
the download and should fail the run visibly. It does not establish Firefox
origin-download behavior, native UI prompt quality, or real quota eviction.


## Firefox MediaPipe CPU real model Download/Remove UI (#55)

Dispatch the **Real Kokoro MV3 model acceptance** workflow manually with
`acceptance_scope: firefox-mediapipe-origin`. This runs the separate
`KOKORO_FIREFOX_ORIGIN_DOWNLOAD=1`,
`KOKORO_FIREFOX_PROVIDER=mediapipe` harness. It packages the Firefox
extension and installs it temporarily for this attended acceptance; normal
CI and the existing heavyweight Firefox matrix still use the verified,
authenticated loopback preloader, unchanged.

The opt-in Firefox origin mode does **not** pre-download the 294,783,298-byte
MediaPipe CPU model on the test runner or run a loopback model server. After
the separately pinned HTTPS dictionary smoke/UI checks, it removes any prior
MediaPipe CPU model data and requires the real extension-manager **Download**
button to become enabled. The click requests the normal narrowly scoped
optional Hugging Face permission. The real Firefox page's fetch is wrapped
to reject non-pinned HTTP(S) URLs and count **actual response-stream bytes**.
The script requires exactly one official model request, a fully consumed
response, the manifest-matching total, the expected UI size and 100% bar,
a granted narrow permission and a successful full cached SHA-256 check.

ONNX CPU cache metadata is compared before and after installation. The
standard Firefox offline MediaPipe CPU inference check then runs with
browser-level networking disabled, followed by the real **Remove** button
and a cache/status check while still offline. The ONNX cache must remain
unchanged. The captured `firefox.json` records `originDownload: true`,
`originModelAcceptance` and `offlineInference`.

**Evidence boundary:** This is an implementation of manual acceptance, not
a passing browser test. Real host permission prompts (especially headless
Firefox), CORS, full transfer, and offline synthesis must be verified by
running the workflow and inspecting its attachment. A temporary Firefox
add-on survives page reload but **not** a browser-process restart; permanent
installation and real quota/eviction remain separate issue #55 gates.


## Firefox ONNX q8 official-host model/voice Cancel/Retry and offline synthesis (#55)

Use the explicitly dispatched **Real Kokoro MV3 model acceptance** workflow with
`acceptance_scope: firefox-onnx-origin`. Its isolated Firefox job sets
`KOKORO_LIVE_DOWNLOAD=1`, `KOKORO_FIREFOX_PROVIDER=onnx`, and
`KOKORO_FIREFOX_ORIGIN_DOWNLOAD=1`. It must **not** run in normal PR CI
or automatically download weights on extension startup.

The test uses the packaged Firefox add-on and the existing real CMUdict
Download/Cancel/Retry/Remove acceptance. Because that dictionary test ends
by removing the asset, the ONNX mode explicitly clicks its actual **Download**
control again and verifies the restored pinned 3,618,488-byte dictionary
with SHA-256 before testing ONNX. This is a separate user-initiated
official-host download, not a hidden model dependency fetch. The tokenizer
mapping is packaged in the extension.

Next, the harness clears only the ONNX q8 cache and snapshots MediaPipe
CPU/GPU cache status. It clicks the real ONNX **Download** control against
the two pinned official Hugging Face assets: the 92,361,116-byte quantized
graph and 524,288-byte voice embedding (92,885,404 bytes total, excluding
the separate dictionary). The test intentionally stalls the second asset,
clicks **Cancel**, and requires the first asset to remain checksum-verified
and the second to remain absent. Only a second explicit click permits the
real pinned voice fetch. It fails if the graph is fetched twice, an unpinned
HTTP(S) URL is requested, the actual received/persisted byte counts disagree
with the manifest, either SHA-256 fails, the narrow host permission is
missing, or the UI size/progress do not match. MediaPipe cache must be
unchanged.

With networking disabled at the Firefox browser level, the harness then
executes ONNX phoneme and English-dictionary synthesis, clicks the real ONNX
**Remove** control, and checks that the dictionary remains verified and
MediaPipe cache is still unchanged. The attached `firefox.json` distinguishes
`originDownload`, `originModelAcceptance.cancelRetry`,
`dictionaryReinstalledThroughUi`, `offlineInference`, and offline removal.

This is **not evidence of a passing Firefox browser run** until the
manual workflow produces a reproducible report. Firefox's headless optional
permission prompt, official HTTPS CORS, interrupted transfer recovery, real
storage quota pressure and true installed-addon process restart require
separate live confirmation; the temporary add-on is not persistent.


## Firefox persistently installed add-on across an actual browser restart (#55)

Dispatch **Real Kokoro MV3 model acceptance** with
`acceptance_scope: firefox-persistent-restart`. The dedicated path
`KOKORO_FIREFOX_PERSISTENT_RESTART=1` uses `latest-devedition` rather
than release Firefox because Mozilla's release channel requires signed
add-ons, whereas an unsigned packaged extension can be installed
non-temporarily for development in Developer Edition after disabling
`xpinstall.signatures.required`.

The acceptance script inspects the **packaged Firefox ZIP** and uses its
manifest `browser_specific_settings.gecko.id` as the expected stable
identity. Selenium installs the ZIP with `temporary=False`, explicitly
reuses one Firefox profile via `-profile`, and records the first
`moz:processID` and `moz-extension://` UUID. It fetches only the
**pinned and checksum-verified** ONNX q8 graph, voice data, and CMUdict
to a local authenticated loopback fixture, then populates extension-origin
Cache Storage. Each asset is SHA-256 checked inside the extension and
the provider and dictionary must report their full pinned byte counts.

Next, the script **quits Firefox completely** and starts a separate
WebDriver/Firefox process with exactly the same on-disk profile. It does
not call any add-on install method on the second process. It requires
a different parent process ID, the same installed Gecko ID and extension
origin, and a normally loadable extension benchmark page. With Firefox
networking explicitly disabled, it independently rechecks both cached
manifests' full SHA-256 digests and sizes and performs real ONNX English
dictionary speech synthesis. This distinguishes a true browser-process
restart from a tab/page reload or a temporary add-on installation.

The isolated report `dist/runtime-acceptance/firefox.json` records
`browserProcessRestarted`, `temporaryAddon: false`, both PIDs,
the persistent extension ID/origin, checksums and byte totals before
and after restart, and `offlineInference`.

**Evidence boundary:** This checks persistence of a permanently
installed unsigned packaged add-on in **Firefox Developer Edition**
using an isolated profile; it does **not** establish signing or restart
behavior in release Firefox, nor user-facing origin HTTPS download
consent, quota/eviction or real installation on a user's profile. The
heavyweight test remains opt-in and needs a passing attached browser
report before marking its acceptance evidence complete. The existing
release-Firefox temporary-add-on tests remain unchanged.


## Chromium quota-manager multi-asset recovery (issue #55)

Use a **manual-only** dispatch of **Real Kokoro MV3 model acceptance** with
`acceptance_scope: chromium-quota-recovery`. This runs
`scripts/validate-real-quota-chromium.mjs` with the explicit
`KOKORO_CHROMIUM_QUOTA_ACCEPTANCE=1` and `KOKORO_LIVE_DOWNLOAD=1`
opt-ins. The script uses a disposable persistent Chromium extension profile,
the actual Cache Storage API and WebCrypto, and the browser's own DevTools
Protocol `Storage.getUsageAndQuota` and `Storage.overrideQuotaForOrigin`
commands. This is **not** a manually thrown/mock `QuotaExceededError`.

Only deterministic in-memory fixtures are used: a 16-KiB dictionary from
a separate provider and a two-asset ONNX-shaped fixture (64-KiB graph and
2-MiB voice). They have valid pinned-repository URL **shapes** and computed
SHA-256 digests, but **no real model data are downloaded or executed**.
Their fetch adapter serves only the fixture bytes; the actual browser still
performs the Cache Storage writes and quota enforcement.

After installing/verifying the independent dictionary, the harness queries
the real extension-origin usage and sets a temporary effective quota only
512 KiB above that usage. It requires confirmation of the quota override,
forces network-offline mode, then calls the production `ModelDataStore.install`
with the two assets. It requires an actual browser quota/storage failure on
the oversized **second** asset, the first asset still present and checksum
verified, the dictionary still valid, and no supposedly complete model.
A browser that does not enforce quotas on extension origins must **fail
visibly**, not falsely report a passing test.

Next, the harness **removes the quota override**, confirms it is inactive,
and explicitly retries installation. The first asset must be reused from its
SHA-256 verified browser cache without a network request; only the missing
second asset is fetched again. Final full integrity verification, explicit
removal, and preservation of the separate dictionary are checked. The
isolated report is uploaded as `chromium-quota.json` alongside any normal
Chromium acceptance report. All cache entries and the isolated browser
profile are discarded when this probe ends. Browser quota overrides are
removed in a `finally` block even if the test fails.

**Evidence boundary:** This adds reproducible **real Chromium quota
pressure** acceptance, not browser-managed automatic eviction and not
Firefox quota acceptance. A manual successful run is required to establish
that a particular Chromium version applies CDP quota overrides to
`chrome-extension://` origins. Firefox quota pressure, browser-triggered
eviction, and heavyweight model downloads remain open in issue #55. Ordinary
PR CI checks the script's syntax only and never runs this heavyweight
manual browser scope.


## Firefox real QuotaManager pressure and recovery (#55)

Dispatch the **Real Kokoro MV3 model acceptance** workflow manually with
`acceptance_scope: firefox-quota-recovery`. This selects Developer Edition,
the existing non-temporary packaged-XPI install, and
`KOKORO_FIREFOX_QUOTA_ACCEPTANCE=1`. Normal PR CI syntax-checks the test
but does not download or install any model data.

The harness uses a **disposable Firefox profile**, a real
`moz-extension://` page, the unchanged production `ModelDataStore`, actual
Firefox Cache Storage, and browser WebCrypto. `scripts/firefox-quota-probe.js`
is injected by Selenium **only during the manual acceptance**; it does not
ship in the add-on. The fixtures use deterministic, high-entropy *synthetic*
bytes with pinned official-URL shapes and independently computed SHA-256.
The 16-KiB dictionary is stored as an independent provider. An ONNX-shaped
manifest has a 96-KiB first asset and a 16-MiB second asset (larger than the deliberately constrained 8-MiB global storage cap). There are **no**
external model fetches, real weights, production permissions or speech
inputs in this test.

Firefox's Gecko QuotaManager preference
`dom.quotaManager.temporaryStorage.fixedLimit` accepts a global temporary
storage limit **in KiB**. The first Firefox process sets an 8-MiB global
limit. The harness verifies the actual parent-process preference and
records `navigator.storage.estimate()` for diagnostics. That estimate is an
**origin-specific** quota and must not be compared with Firefox's global
QuotaManager fixed limit. The harness explicitly installs the separate
dictionary, then calls `ModelDataStore.install()` with both synthetic
model assets. A passing limited phase requires Firefox's **real Cache
Storage/QuotaManager** to reject the large second-asset write with a
quota/storage error, leaving the first asset *fully checksum-verified*,
the independent dictionary intact, no complete model, and no automatic
retry. An unsupported or unenforced preference is a **failed test**, not
a simulated pass.

The browser process then exits. The second process opens the *same
profile* and installed XPI, resets the limit to 128 MiB, verifies the
actual preference and extension identity, disables browser networking,
and runs an **explicit** second install. It must reuse the first verified
asset and fetch **only the absent synthetic voice**, verify both assets
and the dictionary, then remove only the selected model. The browser's configured global quota preference must increase across
processes; its per-origin `navigator.storage.estimate()` is recorded but
need not change. The report is
`dist/runtime-acceptance/firefox-quota.json`, uploaded independently of
`firefox.json`.

**Important Firefox eviction distinction:** Gecko intentionally excludes
installed extension origins from the ordinary inactive-origin automatic
eviction selection (Mozilla bug
[1720487](https://bugzilla.mozilla.org/show_bug.cgi?id=1720487)).
Do not force-delete a Cache Storage entry and call that a real Firefox
browser-managed eviction. The quota failure tested here is a separate
failure mode, and explicit cache deletion remains only a deterministic
repair-regression test. If the observed browser has stricter guarantees
for extension storage, report the behavior rather than creating fake
browser eviction evidence.

**Evidence boundary:** The fixed-limit preference and quota error are
verified only **when the isolated manual workflow runs successfully**.
The test has not yet established success on a real Firefox version.
Developer Edition unsigned-addon behavior is not proof of signed Release
Firefox installation or profile persistence. Full heavyweight model
origin-download reports, Chrome quota execution, and any supportable
browser-managed eviction acceptance remain separate issue #55 gates.

### Firefox quota live failure (2026-11-10)

[Workflow run 42895307873](https://github.com/Fooftilly/kokoro-extension/actions/runs/42895307873) failed during the limited-quota phase. The initial test used a 5-MiB voice fixture and a 96-KiB model fixture under an 8-MiB global cap, so the asset was **too small to guarantee quota pressure**. The original Selenium error wrapper additionally returned Firefox's JavaScript stack without its exception message, obscuring the failed assertion. This is a defect in the acceptance harness, not proven production cache corruption. The next test revision uses a 16-MiB high-entropy voice fixture, asserts it exceeds the global cap before running the write, removes invalid comparisons between per-origin estimates and the global pref, and retains the browser's full exception text. Re-run the manual scope after merging that change; do not treat the original failed run as quota acceptance.


### Chromium MediaPipe official-origin UI timeout (2026-11-10)

[Manually dispatched workflow run 42898267735](https://github.com/Fooftilly/kokoro-extension/actions/runs/42898267735)
on `master` commit `ce5848b0d29d1cf67809650abcf7841b2e9824b4`
**failed** after a 900,000-ms `page.waitForFunction` timeout in the
official-origin model-manager Download flow. The pinned CMUdict download,
SHA-256 verification, browser preflight, and extension setup passed.
The [attached report](https://github.com/Fooftilly/kokoro-extension/actions/runs/42898267735/artifacts/13802518147)
does **not** contain final UI status, byte counts, network request events or
browser-side failure detail, so it does not prove whether the pinned
294,783,298-byte MediaPipe asset was stalled at the upstream source, still
under browser SRI buffering, blocked, or cached without a matching UI result.

The separate test-harness diagnostic follow-up preserves the existing
15-minute upper bound. On timeout and other non-installed terminal states,
it records the model-manager status text, button/progress state, transfer
request/received/completed counts, unexpected URLs, and a **bounded** set
of Playwright HTTP request/response/finish/failure events. CDN query strings,
including signed download parameters, are never recorded. It does not
mock downloads, increase timeouts, download weights in ordinary CI, or
alter the production extension. Re-run this manual scope only after that
follow-up merges; investigate its captured state before choosing a runtime
fix. The failed run is **not** full-model or offline-inference evidence.


### Chromium optional host-consent blocker (2026-11-10)

The second manual `chromium-mediapipe-origin` attempt,
[run 42903782679](https://github.com/Fooftilly/kokoro-extension/actions/runs/42903782679)
on `master` commit `c9970c48fe514851b3235775a0d5d9b9d0134b7f`,
failed after 900,000 ms with the model-manager UI still displaying
`Waiting for model download permission…`. The actual browser reported
zero model HTTP requests, zero received bytes, disabled Download and
no browser crash. The browser never reached the 294,783,298-byte MediaPipe
asset or offline inference; this is **not** a model bandwidth/CDN/SRI
or cache-integrity failure.

Chrome's optional host permission is normally confirmed in a **native
browser dialog**, not an HTML/Playwright `dialog`. The original acceptance
harness used headless Chromium with no way to interact with that prompt.
The manual-only follow-up runs **headed Chromium under isolated Xvfb**
and uses a single native X11 Return input after a real Download click.
It fails if the origin was already granted, the UI does not enter the
expected permission-request state, or Chrome does not subsequently report
the precise `https://huggingface.co/*` permission. This does not
pregrant hosts, alter the shipped manifest, monkey-patch permissions,
or bypass the browser's HTTPS model download or SHA-256 verification.
Only the manual official-origin scopes use Xvfb; normal CI remains
unchanged. The actual browser-dialog interaction must be validated in
a new manual run after this patch merges. A failed Xvfb grant must not
be silently converted into a test pass or a broader permission grant.
