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
acceptance. Firefox restores its network state during cleanup.

The manual-only GitHub Actions workflow tests Chromium and separate Firefox
ONNX/MediaPipe CPU sessions, attaching browser reports. It intentionally
does **not** run on ordinary master pushes or PRs because the live models are
large. CI only syntax-checks the harnesses. The tests still use a runner-side
authenticated loopback transfer of pinned model bytes: they **do not** yet
exercise the actual Download/Cancel/Retry/Remove UI, upstream fetch CORS/SRI,
cache persistence after a browser restart, storage eviction, browser quota,
or user-perceived audio quality. Those remain separate #55 acceptance gates.
