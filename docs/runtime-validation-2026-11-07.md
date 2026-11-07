# Kokoro browser runtimes: measured validation (2026-11-07)

Status: **partial, not release-ready**. This is the reproducible evidence for #53 and parent #52. Real model-backed browser synthesis is distinct from static API availability, mocked tests, and passing builds.

## Reproducible setup

- Browser: **Chromium 158.0.8127.18**, Linux GitHub Actions runner, Manifest V3 extension with `wasm-unsafe-eval` allowed. Test executes inside an installed `chrome-extension://` page, not a normal website. Neither Windows nor Firefox results should be inferred from this run.
- Official WASM runtime: `onnxruntime-web@1.31.1`; WebAssembly, 1 thread; not WebGPU. ONNX model: `onnx-community/Kokoro-82M-v1.0-ONNX@1939ad2a8e416c0acfeecc08a694d14ef25f2231`.
- Official ONNX q8 model: `onnx/model_quantized.onnx` (92,361,116 bytes, SHA-256 `fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478`); voice `voices/af.bin` (524,288 bytes, SHA-256 `a4f11d9d055a12bfa0db2668a3e4f0ef8fd1f1ccca69494479718e44dbf9e41a`). Data transfer totals **92,885,404 bytes (92.9 MB decimal)** excluding executable JS/WASM shipped in the extension.
- Official `@mediapipe/tasks-audio@1.2.2`. Model: `litert-community/Kokoro-82M@33ad69fec6c4d9eb10a547aaf9a8c63e7c446a56`, CPU bundle `kokoro_int8_fp16.litertlm` (294,783,298 bytes, SHA-256 `e7b931ee5d4b7104012a838c9eee240d19ea69cb3ca269041a3274f83dbb7fa1`).
- Every download is initiated only by the explicit opt-in GitHub Actions workflow; byte lengths and SHA-256 are checked before use. No downloaded executable JS/WASM; official runtime scripts come from the bundled, pinned npm dependencies. Tests store model bytes in extension-owned Cache Storage. The temporary authenticated localhost transfer server is only a CI fixture.
- Reproduction: `.github/workflows/live-browser-acceptance.yml` runs `scripts/validate-live-chromium.mjs`; a machine-readable `kokoro-live-chromium-report` artifact contains actual results even when an engine fails. This workflow is intentionally not a claim of supported user deployments.

## Observed results

| Configuration | Result | Evidence |
| --- | --- | --- |
| Chromium MV3 / ONNX q8 / WASM / IPA `hɛˈloʊ.` | **SYNTHESIS PASSED**. Non-silent, finite Float32 PCM, 24,000 Hz, 1.65 s output, RMS ~0.034. | [GitHub live run 42383908575](https://github.com/Fooftilly/kokoro-extension/actions/runs/42383908575) and [repeat 42384678831](https://github.com/Fooftilly/kokoro-extension/actions/runs/42384678831) |
| Chromium MV3 / MediaPipe CPU / 294.8 MB `.litertlm` | **FAILED to initialize.** Official wasm throws `No tokenizer found in the model for model type: tf_lite_prefill_decode`. Failed using modelAssetBuffer, cached Blob modelAssetPath, and direct authenticated URL retaining the original `.litertlm` filename. The file's SHA-256 and byte length match the official Hugging Face repository. | [GitHub live run 42383908575](https://github.com/Fooftilly/kokoro-extension/actions/runs/42383908575) and [filename diagnostic 42384678831](https://github.com/Fooftilly/kokoro-extension/actions/runs/42384678831) |
| Chromium MV3 / MediaPipe GPU | **Not validated**. Do not expose as working merely because WebGPU is present. | Test remains required. |
| Firefox 159.0.1 MV3 / ONNX q8 / WASM / IPA `hɛˈloʊ.` | **SYNTHESIS PASSED** in a real temporary Firefox extension. Non-silent finite 24,000-Hz Float32 PCM, 1.65 s clip, RMS ~0.034. Model initialization ~1.03 s; three warm generations ~1.22 s each. No WebGPU or WASM threads. | [Firefox live run 42385430410](https://github.com/Fooftilly/kokoro-extension/actions/runs/42385430410) |
| Chrome/Firefox / ONNX English text | **PARTIALLY IMPLEMENTED/TESTED**: an original strict CMUdict-based G2P path synthesizes known words after a separate optional verified dictionary download. Unsupported words and arbitrary article text are not accepted; human listening and end-to-end long-form reading remain outstanding. | #60; local Chromium and Firefox acceptance |
| Windows Chrome/Firefox, human listening, memory/peak GPU, long paragraphs | **Not measured**. | Required by #53 |

In one Chromium MV3 ONNX run, model initialization took 1,152.6 ms; 3 completed WAV synthesis times were 1,759.5 / 1,633.3 / 1,625.5 ms for 1.65 s of output. Another run showed initialization 1,485.5 ms, and synthesis 2,219.3 / 1,942.4 / 1,917.7 ms. These are runner-dependent observed *full synthesis* times, not streaming time to first chunk, not user-hardware performance, and not a quality rating. Only syntactic PCM validity and non-silence were tested. No external speech endpoint receives synthesis input.

## Compatibility decision and remaining gates

**Keep all three provider IDs.** Keep Docker/FastAPI unchanged and the default. ONNX q8 has actual Chromium **and Firefox** phoneme-input evidence; it now has a limited original CMUdict-based English G2P path, but still lacks robust arbitrary-text coverage, audible quality review, and production-style user-initiated download acceptance. Do not silently route ONNX text to FastAPI. MediaPipe CPU is a reproducible failed configuration and must remain unavailable in user-facing product claims until an upstream SDK/model compatibility solution is verified with real synthesis. The `modelAssetPath` variant and original filename diagnostic did not repair it.

MediaPipe official web guide describes the model and SDK API: https://developers.google.com/edge/mediapipe/solutions/audio/text_to_speech/web_js ; source model: https://huggingface.co/litert-community/Kokoro-82M . The failure might be an SDK/model metadata incompatibility; no root cause beyond the observed native error has been established. Avoid inventing one.

Still required before #53 closure: reproduce real successful MediaPipe and ONNX speech using production-style cached assets in **both Chrome and Firefox extension origins**; establish supported CPU/GPU model/delegate matrix; verify audible quality/voice selection/cancellation; complete and validate ONNX English G2P beyond the strict dictionary path; measure cold/warm separate metrics, true first-audio, memory and long-form behavior; review bundled MediaPipe SDK's external metrics/privacy behavior; make all tests optional with no silent model download, and rerun the same acceptance on release candidates. #56/#60 remain implementation work.

The extension-owned test page reports **full-clip synthesis p50/p95 and real-time factor**, rather than incorrectly presenting unary completion as streaming time-to-first-audio. A true first-audio timestamp remains unmeasured. Audio requests created before playback reset are invalidated, and failed synthesis entries can be retried after errors; these lifecycle changes are covered by unit tests.

No branch/PR should be merged as a fully functioning dual-local backend on the strength of unit tests, packaged SDK checks, or a successful ONNX IPA probe alone.

## Independent Arch Linux local reproduction (7 November 2026)

A maintainer ran the PR #68 acceptance instructions on Arch Linux (Node.js v26.12.1, Playwright Chromium 158.0.8127.18). Lint, all **308 Jest tests across 22 suites**, packaging for Chrome/Firefox, and packaged runtime verification passed locally. The opt-in Chromium harness downloaded and SHA-256-verified pinned CMUdict, ONNX q8 model/voice data, and the official MediaPipe CPU model.

- **ONNX q8 WASM: passed real extension-origin inference**: initialization ~1246 ms; warm synthesis 1723.6 / 1630.9 / 1608.4 ms; clip 1.65 seconds, 24 kHz, RMS ~0.03405. Independently, `synthesize('Hello world.')` produced a 1.875-second, finite/non-silent 24-kHz clip, RMS ~0.03425. This confirms actual waveform generation, **not subjective quality**.
- **MediaPipe CPU: failed**, with the same native `No tokenizer found in the model for model type: tf_lite_prefill_decode` failure for cached-Blob loading, original-filename URL, and `modelAssetBuffer` diagnostics. No specific root cause has been established; reproduction confirms it is not restricted to the GitHub Actions environment. The cached-Blob path and browser `cacheDirectory: ':nocache'` option were in use.
- The Chromium harness exited nonzero because MediaPipe failed; ONNX passed. Full machine-readable report: `dist/runtime-acceptance/report.json`.
- Local `npm ci` reported 28 dependency audit advisories (5 low, 20 moderate, 2 high, 1 critical). The affected packages and whether they ship in release artifacts **have not yet been audited**; do not assume they are all production-exploitable, and do not blindly apply `npm audit fix --force`.

Follow-up: investigate official MediaPipe SDK/model tokenizer compatibility, verify a working reference model/runtime combination, and test actual user-click model downloads, audible quality, and long-form reading in both browsers. The failing acceptance output remains a merge blocker.

## Installed Chromium manual results (7 November 2026)

The maintainer independently used the extension's user-facing model test page in Chromium on Linux (user agent Chrome/156.0.0.0). The following is **user-reported** acceptance evidence rather than simulated Jest output:

- **ONNX q8 WASM**: real local IPA inference passed with full-clip synthesis p50 **1,560 ms**, p95 **1,621 ms**, and RTF p50 **0.95**. The experimental `Hello world.` dictionary-backed English audio was generated and offered for listening. No affirmative listening-quality assessment or article/EPUB support has been supplied.
- **MediaPipe CPU and GPU**: both failed to create the official `TextToSpeech` task with `No tokenizer found in the model for model type: tf_lite_prefill_decode`. This shows the same tokenizer blocker affects both published variants in this test environment; it does not demonstrate working GPU inference.
- **Capability preflight**: WebAssembly compilation available; `crossOriginIsolated=false`, therefore WASM threads prerequisites absent; WebGPU reported `no-adapter`. GPU acceleration cannot be assumed available in this Chromium session.
- The maintainer requested visible model download progress. PR #68 now has an opt-in download progress indicator with byte counts and completion gated on successful cache storage; **real visual/interactive acceptance of the new indicator is still outstanding**.

The official model/runtime tokenizer incompatibility remains the primary merge blocker. The q8 ONNX success should not be presented as proof of full text/EPUB support.

## Follow-up installed-extension results: both ONNX precisions (7 November 2026)

The maintainer reran all four selectable local model tests from the installed Chromium extension:

| Provider / variant | Full-clip synthesis p50 / p95 (three warm runs) | RTF p50 | Observed outcome |
| --- | --- | --- | --- |
| ONNX q8 WASM | **1,521 / 1,548 ms** | **0.92** | Real IPA synthesis passed. Experimental English dictionary-backed audio generated, but listening-quality acceptance not provided |
| ONNX q8f16 WASM | **1,598 / 1,688 ms** | **0.98** | Real IPA synthesis passed. Experimental English dictionary-backed audio generated, but listening-quality acceptance not provided |
| MediaPipe CPU | — | — | Failed task creation: `No tokenizer found in the model for model type: tf_lite_prefill_decode` |
| MediaPipe GPU | — | — | Same task creation failure; this is not evidence that WebGPU was used |

The optional English pronunciation dictionary is installed at its verified 3.6 MB size. The q8 sample p50 is ~4.8% lower than q8f16; with only three runs and IPA input, this is neither a production performance ranking nor a long-form/English throughput measurement. Prior capability preflight reported `webgpu.status=no-adapter`; the GPU failure must not be interpreted as a functional WebGPU benchmark.

### Targeted next diagnostic: inspect MediaPipe container tokenizer sections

The upstream `litert-community/Kokoro-82M` model card claims the `.litertlm` files include text front-end data and work with the MediaPipe TextToSpeech task, but no published reference run has been independently validated in this extension. Google's official `litert-lm-peek` tool can enumerate the file's sections without extracting weights: https://developers.google.com/edge/litert-lm/file_builder .

The optional Chromium live acceptance script places the checksum-verified CPU bundle at `/tmp/kokoro-live-models/e7b931ee5d4b7104012a838c9eee240d19ea69cb3ca269041a3274f83dbb7fa1` on Linux. If the file still exists after the earlier run, install the official inspector in an isolated venv and run:

```bash
python3 -m venv /tmp/kokoro-litert-peek-venv
/tmp/kokoro-litert-peek-venv/bin/python -m pip install --upgrade litert-lm-builder
/tmp/kokoro-litert-peek-venv/bin/litert-lm-peek --litertlm_file \
  /tmp/kokoro-live-models/e7b931ee5d4b7104012a838c9eee240d19ea69cb3ca269041a3274f83dbb7fa1
```

Review whether a tokenizer is present, what type it is tagged with, and how the TFLite model sections are identified. **No assumption of absent metadata should be made until the inspector output is available.** Do not rewrite or silently substitute downloaded weights or adopt unrelated implementations as a workaround.

## Inspected actual Kokoro LiteRT-LM container (7 November 2026)

The maintainer used the official `litert-lm-builder==0.19.1` package and `litert-lm-peek` on the already SHA-256-verified CPU bundle at the pinned revision. The tool identified **LiteRT-LM format 1.9.0** with **69 sections**, not an empty or plainly missing pronunciation dictionary:

- Section 0: `Text2SpeechMetadataProto` with `tts_model_type { kokoro {} }`, 24,000-Hz output, and nine listed language codes.
- Section 1: `TFLiteModel`, `model_type=tf_lite_acoustic`, constrained to CPU.
- Section 2: `TFLiteModel`, `model_type=tf_lite_vocoder`.
- Sections 3–56: 54 named voice embeddings, including `af_heart`.
- Sections 57–59: `en-lexicon` (12,848,480 bytes), `ja-lexicon`, `zh-lexicon`.
- Sections 60–68: locale-specific text normalization data, including `en-textnorm`, plus `zh-t2s`.

The inspection lists **no `tf_lite_prefill_decode` section**. This is consistent with a Kokoro acoustic/vocoder model rather than an ordinary LLM prefill/decode model; it does **not** show that English lexical resources are absent. The MediaPipe WASM error instead names a different model type, suggesting wrong model-type selection, an SDK/model compatibility failure, or a loading-path issue. The causal path remains **unverified**, so avoid repackaging or adding an unrelated LLM tokenizer.

### Narrow diagnostic correction

Google's [Text-to-Speech model options](https://developers.google.com/edge/mediapipe/solutions/audio/text_to_speech) explicitly say to keep the original model filename because detection can use that filename. The previous Chrome acceptance `originalFilenameDiagnostic` URL ended with `.litertlm?token=...`; while the actual pathname contained the correct filename, this was not an exact filename-suffix reproduction.

Commit `bdf542c` changes only the optional live-browser harness: it uses a 256-bit secret as a **path segment** on an authenticated loopback server, so the requested URL ends exactly with `/kokoro_int8_fp16.litertlm` and still uses the pinned, verified source bytes. No remote executable dependencies or model data are committed. Reruns can reuse downloaded files only after recalculating their full SHA-256. The script still reports failed MediaPipe as a failed acceptance; it does **not** claim to repair the production model loader.

**Maintainer rerun confirmed the exact-suffix diagnostic still fails.** At head `8991a13`, Chromium/Playwright reused four already downloaded SHA-256-verified assets without network model transfers. ONNX q8 passed (initialization 854.5 ms, warm synthesis 1565.0 / 1577.1 / 1558.1 ms, 24-kHz finite non-silent PCM; `Hello world.` dictionary-backed output still passed). MediaPipe's **cached Blob URL**, **exact filename URL with no query string**, and **`modelAssetBuffer`** all failed with the same `No tokenizer found in the model for model type: tf_lite_prefill_decode` error. The live harness's nonzero exit is correct because it requires both adapters to pass.

This excludes the original-filename query suffix as a fix. No evidence warrants adding a generic LLM tokenizer to the Kokoro TTS bundle. The next useful differentiation is testing **the same pinned bytes against the stable native MediaPipe Python 1.2.2 task**, in isolation, to distinguish a broader model/SDK issue from browser-WASM-specific handling. Official Python example: https://developers.google.com/edge/mediapipe/solutions/audio/text_to_speech?tab=Python . Use an isolated Python environment, preserve the original filename, and report whether task creation and real audio succeed; do not update the extension's production provider based on an untested hypothesis.

## Native Python MediaPipe success versus browser-WASM failure (7 November 2026)

This is now a **confirmed cross-runtime difference** using the **same checksum-verified `kokoro_int8_fp16.litertlm`** bytes. The maintainer independently created an isolated Python environment on Arch Linux, installed the published `mediapipe==1.2.2` wheel and NumPy, and invoked `mp.tasks.audio.TextToSpeech.create_from_options` with `mp.tasks.BaseOptions(model_asset_path=.../kokoro_int8_fp16.litertlm, delegate=CPU)`, `default_voice_id='af_heart'`, and a writable cache directory.

Observed native result (not simulated, no network speech server):

- The pinned model's **SHA-256 passed** immediately before the run; the model was accessed via a symlink with its unmodified original basename.
- MediaPipe reported version **1.2.2**. Its native task **initialized successfully**, loaded both TFLite models, registered XNNPACK CPU execution, loaded voice `af_heart`, and successfully initialized the English Kokoro phonemizer.
- A log warning `Section not found: GenericBinaryData (espeak-ng)` did **not** prevent phonemizer initialization or synthesis. Do not treat that warning as the cause of the browser error.
- `tts.synthesize('Hello world.')` returned **39,600 samples**, **24,000 Hz**, peak absolute amplitude **0.2845522165**, and **all samples finite**. This is a valid non-silent **1.65-second** actual PCM clip; perceptual quality was not assessed.
- By contrast, the **same official npm version `@mediapipe/tasks-audio@1.2.2`** packaged inside the Chromium MV3 extension fails before task construction with `No tokenizer found in the model for model type: tf_lite_prefill_decode` for **three loading methods**: cached Blob URL, exact original-filename URL, and `modelAssetBuffer`. The model inspector showed a Kokoro TTS acoustic/vocoder bundle with a lexicon and no LLM `tf_lite_prefill_decode` section.

**Interpretation:** The model weights and native Kokoro integration work, so an intrinsically invalid or missing model/dictionary is **not** a supported diagnosis. The failure is **specific to the tested JavaScript/WASM implementation or its interaction with the extension environment**. The precise responsible layer (npm task wrapper, WASM build, wrong model-capability dispatch, or browser-specific initialization) is **still unknown**; do not claim an upstream defect is proven until an independent plain-web official reference test or a verified SDK change demonstrates the difference.

**Next verification:** Run the published [official MediaPipe Text-to-Speech web demo](https://google-ai-edge.github.io/mediapipe-samples-web/) with the same CPU model/SDK if possible, or an isolated minimal HTML page using the packaged 1.2.2 JavaScript/WASM files and the same pinned model, outside the extension. This separates a general web-WASM incompatibility from extension-specific loading/CSP/caching. Keep executable code pinned and local to extension builds; no speculative fallback to Python, server TTS, unrelated wasm libraries, or altered model container. Neither the ONNX implementations nor FastAPI are affected by this diagnosis.

### Isolate browser WASM from Manifest V3 (no downloads)

The repository now contains `scripts/diagnose-mediapipe-web.mjs`, which runs **the same packaged official MediaPipe 1.2.2 JS/WASM assets** on an ordinary, same-origin `http://127.0.0.1` web page, rather than inside the Chrome extension. It reads the **already downloaded CPU model** at `/tmp/kokoro-live-models/<pinned SHA-256>`, validates its full bytes/hash against `model-catalog.js`, and serves the model at a URL that ends in its exact `.litertlm` filename. This provides a controlled comparison without external services or downloading model bytes again. The localhost model source is a development-only diagnostic; production retains opt-in model downloads and Cache Storage.

After `npm run package:ci` (which builds the signed-package SDK assets), run from the repo root:

```bash
PW_MODULE="$(find /tmp -type f -path '*/node_modules/playwright/index.mjs' -print -quit)"
PLAYWRIGHT_MODULE_PATH="$PW_MODULE" node scripts/diagnose-mediapipe-web.mjs
python3 -m json.tool dist/runtime-acceptance/mediapipe-plain-web.json
```

The script outputs `dist/runtime-acceptance/mediapipe-plain-web.json` and returns a nonzero status if real synthesis fails. It does not load the browser extension, does not use any CDN, and does not change the installed packages. **The maintainer ran the isolated plain-web test in HeadlessChrome 158.0.0.0 on Arch Linux.** It failed with the **identical** `No tokenizer found in the model for model type: tf_lite_prefill_decode` error from the same `audio_wasm_internal.wasm` stack, while `pageErrors: []`. The verified CPU model had SHA-256 `e7b931ee5d4b7104012a838c9eee240d19ea69cb3ca269041a3274f83dbb7fa1`; it was served as `/models/kokoro_int8_fp16.litertlm` on a plain HTTP localhost origin. This **demonstrates failure of the tested official JavaScript/WASM SDK outside Manifest V3**, independent of extension CSP, permissions, Cache Storage, or Blob handling. It does not prove an SDK bug is unfixable or identify the exact wrong-dispatch instruction.

### Official SDK version comparison (no production dependency change)

The new `MEDIAPIPE_WEB_RUNTIME_DIR` override on `scripts/diagnose-mediapipe-web.mjs` allows comparison against a **separately installed pinned upstream MediaPipe prerelease package** without touching the extension's dependency lockfile or signed assets. The same pinned Kokoro model, local serving path, Chromium, and valid PCM criteria are retained.

```bash
SDK_DIR="$(mktemp -d /tmp/kokoro-mediapipe-prerelease-XXXXXX)"
npm install --prefix "$SDK_DIR" --no-save --ignore-scripts --package-lock=false \
  '@mediapipe/tasks-audio@1.2.2-rc.20261106'
PW_MODULE="$(find /tmp -type f -path '*/node_modules/playwright/index.mjs' -print -quit)"
MEDIAPIPE_WEB_RUNTIME_DIR="$SDK_DIR/node_modules/@mediapipe/tasks-audio" \
PLAYWRIGHT_MODULE_PATH="$PW_MODULE" \
node scripts/diagnose-mediapipe-web.mjs
```

**The official prerelease now has independently verified plain-web real inference.** The maintainer installed exactly `@mediapipe/tasks-audio@1.2.2-rc.20261106` in a separate /tmp directory and reran the isolated plain-web diagnostic with the *same pinned Kokoro CPU model*, unchanged browser and same-origin local harness. It **succeeded** under HeadlessChrome 158: initialization **1,899 ms**, **38,400** samples at **24,000 Hz**, RMS **0.0465186341**, and **no page errors**. This is a successful real model-backed WebAssembly TTS inference, versus the proven failure with official stable `1.2.2`. It does not yet establish which change in the prerelease fixed the problem.

The PR now **pins the exact prerelease** `@mediapipe/tasks-audio@1.2.2-rc.20261106` in both `package.json` and `package-lock.json` using the official npm tarball URL and published SHA-512 integrity checksum. This is a deliberate release-candidate dependency for validating the extension; it is not yet a confirmed production-ready replacement. The existing Chrome and Firefox packaging process copies the official SDK JS/WASM from this pinned npm dependency. **Full Chrome and Firefox extension-origin audio acceptance remains outstanding**, as do the documented user-facing download, long-form speech and playback behavior gates.

Run the existing live Chromium harness using the pinned branch artifacts, without replacing dependencies externally:

```bash
git pull --ff-only
npm ci --ignore-scripts
npm run package:ci
PW_MODULE="$(find /tmp -type f -path '*/node_modules/playwright/index.mjs' -print -quit)"
KOKORO_LIVE_DOWNLOAD=1 PLAYWRIGHT_MODULE_PATH="$PW_MODULE" node scripts/validate-live-chromium.mjs
```

The test reuses local pinned model data after checksum validation; the script exits with an error if either actual ONNX or MediaPipe synthesis fails, and writes `dist/runtime-acceptance/report.json`. Model/voice and text must stay local with no silent fallback to FastAPI. The Chrome MV3 harness writes `dist/runtime-acceptance/report.json`; the separate plain-web diagnostic writes `dist/runtime-acceptance/mediapipe-plain-web.json`. Do not use a stale plain-web report as proof of current extension-origin acceptance.

## Chromium extension crash after pinned prerelease update (7 November 2026)

After updating PR #68 to the proven plain-web `@mediapipe/tasks-audio@1.2.2-rc.20261106` and rerunning `npm ci --ignore-scripts` / `npm run package:ci` on Arch Linux (Node 26.12.1, Playwright Chromium 158), the maintainer ran the real Chrome MV3 acceptance script. Its SHA-256 verification/reuse for the pinned CMUdict, ONNX q8, voice embedding, and 294.8 MB Kokoro CPU model all succeeded. ONNX real extension-origin synthesis **passed**: initialization 876.2 ms, three warm syntheses 1581 / 1566.8 / 1558.5 ms, 24 kHz, RMS ~0.03405; separate experimental English output also passed, RMS ~0.03425.

**MediaPipe did not return the prior tokenizer exception**. Instead, Playwright reported `page.waitForFunction: Target crashed` during the MediaPipe probe, before a MediaPipe synthesis result could be collected. This means the prerelease's extension-origin success or failure is **unknown**, not a verified MediaPipe pass. This does **not prove an out-of-memory (OOM) fault**; it could be renderer memory pressure, native WASM failure, or another browser crash cause. The previous harness ran ONNX and MediaPipe sequentially inside **the same renderer page**, potentially retaining large WASM allocations.

Commit `9d74f29` adjusts only the optional Chrome acceptance harness to close the preflight page, use a **fresh browser page for each model probe**, and close the page after each model. The model cache remains extension-scoped and each model still must be checksum-verified. It also introduces `KOKORO_LIVE_PROVIDER=mediapipe|onnx|both` (default `both`) for targeted isolation and persists a failure record with `crashed` and `stage` into `dist/runtime-acceptance/report.json` before surfacing Playwright errors. The script does **not** ignore crashes, suppress failures, weaken PCM checks or change the runtime provider. CI and CodeQL passed, but **a new real-model run after that harness commit is still required**.

For the first rerun, **isolate MediaPipe** to avoid the previously observed ONNX-then-MediaPipe peak-memory overlap:

```bash
cd ~/GitHub/kokoro-extension
git pull --ff-only
# Rebuild only when the checked-out code or pinned dependencies changed:
npm ci --ignore-scripts
npm run package:ci
PW_MODULE="$(find /tmp -type f -path '*/node_modules/playwright/index.mjs' -print -quit)"
test -f "$PW_MODULE" || exit 1
KOKORO_LIVE_DOWNLOAD=1 KOKORO_LIVE_PROVIDER=mediapipe \
PLAYWRIGHT_MODULE_PATH="$PW_MODULE" node scripts/validate-live-chromium.mjs
python3 -m json.tool dist/runtime-acceptance/report.json
```

**Confirmed MediaPipe-only Chrome MV3 acceptance (maintainer local run, 7 November 2026):** With the exact pinned official MediaPipe prerelease and the checksum-verified `kokoro_int8_fp16.litertlm` model, the per-provider harness **passed real speech synthesis**: initialization **1,387.1 ms**, three warm full-clip syntheses **14,209.9 / 12,217.5 / 13,813.1 ms**, output **3.05 s** at **24,000 Hz**, RMS **0.048362**, and no renderer crash. The median is **13,813.1 ms**, equivalent to approximately **4.53× real time** for this tested sentence, so usable playback speed/latency is **not yet established**. The three runs are full-clip times rather than time-to-first-audio. Chromium's reported WebGPU adapter was unavailable, so this is a **CPU result only**, not GPU acceptance.

This isolated run confirms that `@mediapipe/tasks-audio@1.2.2-rc.20261106` can perform valid **MediaPipe CPU inference inside a Chrome MV3 extension**. It does **not** prove the prior crash's cause or that the original combined ONNX→MediaPipe test now passes. Because the initial failing run shared a renderer and the new passing run uses a fresh page, retained WASM memory is a plausible explanation but unconfirmed. The extension's regular article/EPUB flows, voice quality, GPU delegate, and Firefox remain unverified.

**Next Chrome gate:** run the same script with the default `both` provider selection (omit `KOKORO_LIVE_PROVIDER`), which allocates a separate page for each model and records both real results in `dist/runtime-acceptance/report.json`. The ONNX and MediaPipe tests use different input texts; **do not treat the reported times as a controlled performance comparison**. If the combined test still crashes, preserve the stage and crash report and inspect matching kernel/browser evidence rather than assuming OOM. Do not add server or third-party runtime fallback.

## Combined Chromium MV3 model-backed acceptance passed (7 November 2026)

The maintainer ran the default `KOKORO_LIVE_DOWNLOAD=1` / `KOKORO_LIVE_PROVIDER=both` Chromium harness on Arch Linux after committing the per-model page isolation. All four pinned input assets were reused **only after full size and SHA-256 validation**; no new model download was needed. This is evidence from the **actual extension origin**, not a mock or an ordinary web page.

| Variant | Initialization | Warm full-clip syntheses (3 runs) | Audio | Measured validity |
| --- | ---: | --- | --- | --- |
| ONNX q8 CPU (WASM) | **1,132.1 ms** | **1,550.7 / 1,539.7 / 1,530.3 ms** | 1.65 sec at 24 kHz; RMS 0.0340519 | **Passed** real IPA inference; separately `Hello world.` with pinned dictionary yielded 1.875 sec, RMS 0.0342531 |
| MediaPipe CPU (WASM) | **1,367.5 ms** | **12,222.2 / 13,121.2 / 13,302.6 ms** | 3.05 sec at 24 kHz; RMS 0.0483620 | **Passed** real plain-text inference using official pinned `@mediapipe/tasks-audio@1.2.2-rc.20261106` |

The original sequential same-renderer crash **did not recur** after running the two providers in separate renderer pages within the same browser context. This establishes that the combined Chrome MV3 CPU acceptance now passes in this configuration, but it **does not identify the original crash's cause**. Chromium reported `webgpu.status=no-adapter` and `crossOriginIsolated=false`: these CPU results **do not demonstrate GPU or multithreaded WASM**.

The median MediaPipe warm run was **13,121.2 ms** to produce **3.05 seconds** of output (approximately **4.30× real-time factor**). The median ONNX IPA run was **1,539.7 ms** for **1.65 seconds** of output (~**0.93×**). The test sentences differ, so this is not a controlled provider comparison. Both figures are **full-clip completion latency**, not streaming time-to-first-audio.

**What passed:** official downloaded model-data integrity, packaged runtime loading, full waveform synthesis, sample-rate and non-silent finite-sample checks, and ONNX's limited dictionary-backed English text check, all inside Chrome MV3.

**Not yet verified:** audible voice quality; opt-in download-progress UI on a full real network transfer; long-form article/EPUB integration and cancellation; multi-sentence behavior and memory over time; Chrome GPU execution (no adapter); MediaPipe extension-origin **Firefox** (existing Firefox live harness currently tests ONNX q8 only); security/privacy and version-stability of the official prerelease; standardized same-text comparative benchmarks.

PR #68 therefore remains **open**, with further functional acceptance and independent review required before declaring three complete backends. Do not replace the official MediaPipe SDK, change models, or silently fall back to FastAPI.

## Firefox opt-in MediaPipe CPU acceptance

The Firefox live harness formerly tested only ONNX q8 and dictionary-backed English. PR #68 now supports a separate **MediaPipe CPU** test with `KOKORO_FIREFOX_PROVIDER=mediapipe` while retaining ONNX as the **default** (`KOKORO_FIREFOX_PROVIDER=onnx` or unset). Selection is explicit: the two large engines do not execute sequentially in a single Firefox renderer. The script validates a complete `kokoro_int8_fp16.litertlm` download with the pinned SHA-256 and size, and reuses the same verified files previously downloaded for Chromium at `/tmp/kokoro-live-models/<digest>` when available. The Firefox extension's model cache is still populated from this verified local source, so it exercises actual packaged JS/WASM with no model weights committed or remote executable code. Default CI Firefox behavior remains ONNX.

**On Arch Linux**, with Firefox and `geckodriver` installed and the PR's Chrome/Firefox packages rebuilt after any SDK change:

```bash
cd ~/GitHub/kokoro-extension
git pull --ff-only
npm run package:ci

command -v firefox
command -v geckodriver
PY_ENV="$(mktemp -d /tmp/kokoro-ff-venv-XXXXXX)"
python3 -m venv "$PY_ENV"
"$PY_ENV/bin/pip" install 'selenium==4.38.0' urllib3
KOKORO_LIVE_DOWNLOAD=1 \
KOKORO_FIREFOX_PROVIDER=mediapipe \
FIREFOX_BINARY="$(command -v firefox)" \
MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 \
"$PY_ENV/bin/python" scripts/validate-live-firefox.py

python3 -m json.tool dist/runtime-acceptance/firefox.json
```

A successful result must identify `provider: mediapipe`, `status: passed`, three measured warm syntheses, finite non-silent 24-kHz samples and the Firefox extension ID. A reported error is a failing acceptance, not a skipped gate. **This MediaPipe Firefox path has not yet been run by the maintainer**, so it is not a verified compatibility claim. If the default ONNX acceptance is also run, preserve one `firefox.json` between runs because the next one overwrites it.

## Firefox 159 MediaPipe PCM validation failure (7 November 2026)

The maintainer reran the dedicated `KOKORO_FIREFOX_PROVIDER=mediapipe` acceptance with Firefox **159.0.1** on Arch Linux. The identical pinned **294,783,298-byte** CPU model was reused after full SHA-256 verification, and the Firefox temporary MV3 extension installed successfully. Capability preflight reported `wasmCompilation=true`, `secureContext=true`, `crossOriginIsolated=false`, `sharedArrayBuffer=false`, and `webgpu.status=not-exposed`.

MediaPipe progressed **past model initialization and into its `engine.synthesize()` call**, unlike the original tokenizer failure. The provider then raised a `TypeError: Expected nonempty, bounded Kokoro 24-kHz Float32 PCM` at `validateKokoroPcm` (`pcm-wav.js:10`, `mediapipe-provider.js:100`). The harness correctly marked Firefox acceptance **failed**, with no sample metadata. That generic validator error combined three independent predicates: a `samples instanceof Float32Array` type check, exactly 24-kHz sample rate, and a nonempty/bounded sample count. **The observed exception does not reveal which predicate failed.** It is therefore not yet correct to assert that Firefox generated valid PCM or that the SDK definitely returned a foreign-realm typed array.

Commit `37dd24e` makes the shared PCM validator accept only **real Float32 typed-array views regardless of their JavaScript realm**, checked with `ArrayBuffer.isView` plus the native `[object Float32Array]` tag. The same check applies to WAV encoding so valid foreign-realm audio does not later fail export. It also reports mismatched **sample type, sample rate, or sample count separately**. Every existing NaN, Infinity, silence, duration and 24-kHz safety check remains in place: this does **not** coerce numeric arrays, float64 arrays, integer arrays, or invalid waveform data into a pass. Targeted Jest tests cover foreign-realm valid audio and rejecting invalid types/rates/silence.

This is a **hypothesis-driven compatibility change**, not a verified Firefox runtime fix. A new rebuild plus real Firefox test is required; it will either pass genuinely valid PCM or return a more specific failure identifying exactly what the SDK produced. Do not weaken the PCM acceptance gates, merge, or infer GPU functionality from this run.
