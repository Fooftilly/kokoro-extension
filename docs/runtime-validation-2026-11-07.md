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
