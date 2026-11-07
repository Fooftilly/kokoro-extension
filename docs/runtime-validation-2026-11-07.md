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
| Chrome/Firefox / ONNX arbitrary text | **Not implemented**: IPA-to-token input works but an original licensed text-to-phoneme frontend does not yet exist. | #60 |
| Windows Chrome/Firefox, human listening, memory/peak GPU, long paragraphs | **Not measured**. | Required by #53 |

In one Chromium MV3 ONNX run, model initialization took 1,152.6 ms; 3 completed WAV synthesis times were 1,759.5 / 1,633.3 / 1,625.5 ms for 1.65 s of output. Another run showed initialization 1,485.5 ms, and synthesis 2,219.3 / 1,942.4 / 1,917.7 ms. These are runner-dependent observed *full synthesis* times, not streaming time to first chunk, not user-hardware performance, and not a quality rating. Only syntactic PCM validity and non-silence were tested. No external speech endpoint receives synthesis input.

## Compatibility decision and remaining gates

**Keep all three provider IDs.** Keep Docker/FastAPI unchanged and the default. ONNX q8 has actual Chromium **and Firefox** phoneme-input evidence; it still lacks text normalization/G2P, audible quality review, and production-style user-initiated download acceptance. Do not silently route ONNX text to FastAPI. MediaPipe CPU is a reproducible failed configuration and must remain unavailable in user-facing product claims until an upstream SDK/model compatibility solution is verified with real synthesis. The `modelAssetPath` variant and original filename diagnostic did not repair it.

MediaPipe official web guide describes the model and SDK API: https://developers.google.com/edge/mediapipe/solutions/audio/text_to_speech/web_js ; source model: https://huggingface.co/litert-community/Kokoro-82M . The failure might be an SDK/model metadata incompatibility; no root cause beyond the observed native error has been established. Avoid inventing one.

Still required before #53 closure: reproduce real successful MediaPipe and ONNX speech using production-style cached assets in **both Chrome and Firefox extension origins**; establish supported CPU/GPU model/delegate matrix; verify audible quality/voice selection/cancellation; implement original ONNX English G2P; measure cold/warm separate metrics, true first-audio, memory and long-form behavior; review bundled MediaPipe SDK's external metrics/privacy behavior; make all tests optional with no silent model download, and rerun the same acceptance on release candidates. #56/#60 remain implementation work.

The extension-owned test page reports **full-clip synthesis p50/p95 and real-time factor**, rather than incorrectly presenting unary completion as streaming time-to-first-audio. A true first-audio timestamp remains unmeasured. Audio requests created before playback reset are invalidated, and failed synthesis entries can be retried after errors; these lifecycle changes are covered by unit tests.

No branch/PR should be merged as a fully functioning dual-local backend on the strength of unit tests, packaged SDK checks, or a successful ONNX IPA probe alone.
