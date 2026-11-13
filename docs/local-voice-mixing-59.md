# Local weighted voice mixing investigation (#59)

## Summary

| Backend | Weighted mixing | Decision |
| --- | --- | --- |
| Kokoro-FastAPI | Yes (`af_sarah(5)+af_nicole(3)+…`) | Unchanged |
| MediaPipe Kokoro | No official blend API | Single `voiceId` only + explicit UI |
| ONNX Runtime Web | Style tensor is blendable; catalog is single-voice today | Single voice in product UI; original style-vector lerp tested for future multi-voice assets |

## MediaPipe (official API)

Google AI Edge TextToSpeech / Kokoro-82M documents per-utterance `SynthesisOptions.voiceId` (and `locale`). There is no documented multi-voice weight string or blend API. Voices are switched one ID at a time without reloading the `.litertlm` bundle. **Do not** invent a MediaPipe blend or mix PCM from parallel synthesizes.

Sources: [MediaPipe Text-to-Speech](https://developers.google.com/edge/mediapipe/solutions/audio/text_to_speech), [litert-community/Kokoro-82M](https://huggingface.co/litert-community/Kokoro-82M).

## ONNX (official model contract)

Published ONNX usage selects one voice `.bin`, reshapes to `(-1, 1, 256)`, and picks `style = voices[len(tokens)]` for the unpadded phoneme count. Inputs are `input_ids`, `style` `[1, 256]`, `speed`. This extension already mirrors that in `onnx-kokoro-inputs.js` (`styleForLength`).

Linear interpolation of equal-length style vectors is a low-overhead, original in-repository operation on those tensors (`blendStyleVectors` / `styleForLengthWeighted`). It is **not** a copy of kokoro-js. It is also **not** enabled in the product path yet: `model-catalog.js` only pins `voices/af.bin`. Shipping weighted ONNX mixing in the UI waits on verified multi-voice asset downloads (#55/#58 follow-ons). Until then, disclose single-voice-only.

Source: [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) (Python sample).

## Preference separation

- `browser.storage.sync.voice` — FastAPI weighted mix string only.
- `browser.storage.sync.localVoice` — single local voice ID (`xx_name`).
- Switching to MediaPipe/ONNX must not clear or rewrite `voice`.
- Popup shows the mixer for FastAPI and a single-voice control + limitation note for local backends.
- Test page (`benchmark.html` / model manager) states the same limitation.

## Rejected shortcut

Running one full synthesis per voice and mixing PCM is out of scope for #59.
