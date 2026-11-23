# Local weighted voice mixing investigation (#59)

## Summary

| Backend | Weighted mixing | Decision |
| --- | --- | --- |
| Kokoro-FastAPI | Yes (`af_sarah(5)+af_nicole(3)+…`) | Unchanged |
| MediaPipe Kokoro | No official blend API | Curated Kokoro-82M `<select>` (+ optional advanced custom ID) |
| ONNX Runtime Web | Style tensor is blendable; catalog offers selectable assets | Default `voices/af.bin` with onnx-q8; optional `voices/af_bella.bin` download (#60); style-vector lerp remains available for future weighted mixes |

## MediaPipe (official API)

Google AI Edge TextToSpeech / Kokoro-82M documents per-utterance `SynthesisOptions.voiceId` (and `locale`). There is no documented multi-voice weight string or blend API. Voices are switched one ID at a time without reloading the `.litertlm` bundle. **Do not** invent a MediaPipe blend or mix PCM from parallel synthesizes.

Sources: [MediaPipe Text-to-Speech](https://developers.google.com/edge/mediapipe/solutions/audio/text_to_speech), [litert-community/Kokoro-82M](https://huggingface.co/litert-community/Kokoro-82M).

## ONNX (official model contract)

Published ONNX usage selects one voice `.bin`, reshapes to `(-1, 1, 256)`, and picks `style = voices[len(tokens)]` for the unpadded phoneme count. Inputs are `input_ids`, `style` `[1, 256]`, `speed`. This extension already mirrors that in `onnx-kokoro-inputs.js` (`styleForLength`).

Linear interpolation of equal-length style vectors is a low-overhead, original in-repository operation on those tensors (`blendStyleVectors` / `styleForLengthWeighted`). It is **not** a copy of kokoro-js. Weighted ONNX mixing in the UI is still not enabled: the popup offers a **select** among catalogued single-voice assets (`voices/af.bin` bundled with onnx-q8; optional `voices/af_bella.bin` as a separate download for #60 voice-change). Shipping weighted mixes waits on verified multi-voice blend UX.

Source: [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) (Python sample).

## Preference separation

Three independent sync keys (never rewritten when switching backends):

| Key | Backend | Editable |
| --- | --- | --- |
| `browser.storage.sync.voice` | FastAPI weighted mix | Yes (mixer) |
| `browser.storage.sync.mediaPipeVoice` | MediaPipe `voiceId` | Yes (curated select of 54 Kokoro-82M IDs; optional advanced free-text) |
| `browser.storage.sync.onnxVoiceAsset` | ONNX catalog asset | Yes (catalog select: `af.bin` / `af_bella.bin`) |

Legacy `localVoice` is read once as a MediaPipe fallback when `mediaPipeVoice` is absent.
Callers must **not** pass a `mediaPipeVoice` default into `browser.storage.sync.get(...)`, or the fallback is masked and upgrades reset to `af_heart`.

- Switching to MediaPipe/ONNX must not clear or rewrite `voice`.
- Switching between MediaPipe and ONNX must not overwrite the other local preference.
- Popup shows the mixer for FastAPI, a curated MediaPipe voice select (optional advanced custom ID), or an ONNX catalog voice-asset select + limitation note.
- Test page (`benchmark.html` / model manager) states the same limitation.

## Rejected shortcut

Running one full synthesis per voice and mixing PCM is out of scope for #59.
