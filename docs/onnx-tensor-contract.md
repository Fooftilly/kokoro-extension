# Original ONNX Kokoro tensor contract (partial #60)

This is a small, independently written tensor adapter based on the published official Kokoro v1.0 ONNX model card:
https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX

The documented model input names are input_ids (int64 [1, token count + 2]), style (float32 [1, 256]) and speed (float32 [1]). Input phoneme IDs must have a zero pad at the start and end and no more than 510 unpadded tokens. Official voice data is a raw little-endian float32 table of 256 values per sequence length; row selected is the UNPADDED token count. The original adapter validates and constructs these arrays, and can wrap them using an explicitly supplied official ONNX Runtime Web Tensor constructor.

This PR deliberately does NOT add a grapheme-to-phoneme frontend, WASM runtime packages, inference session, model download, or runnable speech generation. Token IDs supplied by a real phonemizer must be validated and tested for languages/voices separately. Unit tests use entirely synthetic tokens and voice assets, not a live model.

Remaining requirements:
1. Verify and select an appropriate licensed text normalization/G2P implementation for each language; do not reuse Kokoro-JS/other extension source code.
2. Pin official onnxruntime-web JS and WASM in both browser packages and use the real ONNX model graph from a pinned HF revision with checksums via #55.
3. Select actual supported q8/WASM and fp32/WebGPU variants through browser capability and successful inference tests (#53). Firefox WASM is mandatory; do not assume Firefox WebGPU.
4. Create and run a real ONNX Runtime session using these tensors, check 24kHz PCM audible quality, time-to-first-audio, memory and cancellation; integrate with shared provider #54, playback #57, downloads #55 and benchmark page #61.
5. Preserve existing FastAPI server mode and separate voice settings. Never fall back from local ONNX to remote speech generation.

No source copied from another browser project; data shapes here come from the official published ONNX model specification.
