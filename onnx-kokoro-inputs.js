// Original Kokoro v1.0 ONNX input preparation from the published model interface.
// This is not a phonemizer or an ONNX inference engine. It only prepares tensors
// for the official onnxruntime-web package once model-backed integration is added.
const MAX_PHONEMES = 510; // 512 graph positions minus start/end zero pad tokens.
const VOICE_DIMENSION = 256;
const BYTES_PER_STYLE = VOICE_DIMENSION * Float32Array.BYTES_PER_ELEMENT;

function assertPhonemes(ids) {
    if (!Array.isArray(ids) &&
        !(ArrayBuffer.isView(ids) && !(ids instanceof DataView))) {
        throw new TypeError('Kokoro expects an array of phoneme token IDs');
    }
    if (ids.length < 1 || ids.length > MAX_PHONEMES) {
        throw new RangeError('Kokoro phoneme input must contain 1 to 510 tokens');
    }
    for (const id of ids) {
        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new TypeError('Phoneme IDs must be positive safe integers (0 is reserved for padding)');
        }
    }
}

function voiceBytesView(buffer) {
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    if (buffer instanceof Uint8Array) return buffer;
    throw new TypeError('Voice styles must be a binary Uint8Array or ArrayBuffer');
}

// Official v1.0 ONNX voice assets store 256 float32 style values for each
// phoneme-sequence length. Select style at index = unpadded token count.
export function styleForLength(voiceBinary, tokenCount) {
    const bytes = voiceBytesView(voiceBinary);
    if (bytes.byteLength % BYTES_PER_STYLE !== 0) {
        throw new TypeError('Voice binary must contain complete 256-float style vectors');
    }
    if (!Number.isSafeInteger(tokenCount) || tokenCount < 1 ||
        tokenCount >= bytes.byteLength / BYTES_PER_STYLE) {
        throw new RangeError('No voice style vector for the requested token length');
    }
    const style = new Float32Array(VOICE_DIMENSION);
    const start = tokenCount * BYTES_PER_STYLE;
    const view = new DataView(bytes.buffer, bytes.byteOffset + start, BYTES_PER_STYLE);
    for (let i = 0; i < VOICE_DIMENSION; i++) {
        style[i] = view.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true);
        if (!Number.isFinite(style[i])) {
            throw new TypeError('Voice style contains a non-finite float');
        }
    }
    return style;
}

/**
 * Original linear blend of Kokoro ONNX style vectors (official shape [256]).
 * Weights are normalized to sum to 1. Not a PCM mix and not derived from kokoro-js.
 * Product UI stays single-voice until multiple verified voice binaries are catalogued.
 */
export function blendStyleVectors(styles, weights) {
    if (!Array.isArray(styles) || styles.length < 1) {
        throw new TypeError('At least one style vector is required');
    }
    if (!Array.isArray(weights) || weights.length !== styles.length) {
        throw new TypeError('Style blend weights must align with style vectors');
    }
    let weightSum = 0;
    for (let i = 0; i < styles.length; i++) {
        const style = styles[i];
        const weight = weights[i];
        if (!(style instanceof Float32Array) || style.length !== VOICE_DIMENSION) {
            throw new TypeError('Each style must be a Float32Array of length 256');
        }
        if (!Number.isFinite(weight) || weight < 0) {
            throw new RangeError('Style blend weights must be finite and non-negative');
        }
        weightSum += weight;
    }
    if (weightSum <= 0) {
        throw new RangeError('Style blend weights must sum to a positive value');
    }
    const out = new Float32Array(VOICE_DIMENSION);
    for (let i = 0; i < styles.length; i++) {
        const scale = weights[i] / weightSum;
        if (scale === 0) continue;
        const style = styles[i];
        for (let j = 0; j < VOICE_DIMENSION; j++) {
            out[j] += style[j] * scale;
        }
    }
    for (let j = 0; j < VOICE_DIMENSION; j++) {
        if (!Number.isFinite(out[j])) {
            throw new TypeError('Blended style contains a non-finite float');
        }
    }
    return out;
}

export function styleForLengthWeighted(voiceBinaries, weights, tokenCount) {
    if (!Array.isArray(voiceBinaries) || voiceBinaries.length < 1) {
        throw new TypeError('At least one voice binary is required');
    }
    const styles = voiceBinaries.map((binary) => styleForLength(binary, tokenCount));
    return blendStyleVectors(styles, weights);
}

export function prepareKokoroOnnxInputs(phonemeIds, voiceBinary, speed = 1.0) {
    assertPhonemes(phonemeIds);
    if (!Number.isFinite(speed) || speed <= 0 || speed > 4) {
        throw new RangeError('Kokoro speaking speed must be positive and at most 4');
    }

    const inputIds = new BigInt64Array(phonemeIds.length + 2);
    for (let i = 0; i < phonemeIds.length; i++) {
        inputIds[i + 1] = BigInt(phonemeIds[i]);
    }
    // Both edge elements remain zero (the padding ID).
    return {
        input_ids: { type: 'int64', data: inputIds, dims: [1, inputIds.length] },
        style: {
            type: 'float32', data: styleForLength(voiceBinary, phonemeIds.length),
            dims: [1, VOICE_DIMENSION],
        },
        speed: { type: 'float32', data: new Float32Array([speed]), dims: [1] },
    };
}

// Pass an explicitly injected instance of the OFFICIAL onnxruntime-web package.
// Keeps this module independent of third-party wrappers, environment and model fetch.
export function asOnnxRuntimeFeeds(ort, inputs) {
    if (!ort || typeof ort.Tensor !== 'function') {
        throw new TypeError('Official ONNX Runtime Web Tensor constructor is required');
    }
    const result = {};
    for (const name of ['input_ids', 'style', 'speed']) {
        const value = inputs[name];
        if (!value || !value.type || !value.data || !value.dims) {
            throw new TypeError('Missing Kokoro input: ' + name);
        }
        result[name] = new ort.Tensor(value.type, value.data, value.dims);
    }
    return result;
}
