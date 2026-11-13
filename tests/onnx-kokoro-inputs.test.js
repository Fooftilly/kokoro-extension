import {
    styleForLength, blendStyleVectors, styleForLengthWeighted,
    prepareKokoroOnnxInputs, asOnnxRuntimeFeeds
} from '../onnx-kokoro-inputs.js';

function voiceFixture() {
    const bytes = new Uint8Array(5 * 256 * 4);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 256; i++) {
        view.setFloat32((3 * 256 + i) * 4, i / 1000, true);
    }
    return bytes;
}

describe('original Kokoro ONNX tensor preparation (#60)', () => {
    test('pads phonemes and selects the voice vector at unpadded token length', () => {
        const inputs = prepareKokoroOnnxInputs([11, 42, 7], voiceFixture(), 1.25);
        expect(inputs.input_ids.type).toBe('int64');
        expect(inputs.input_ids.dims).toEqual([1, 5]);
        expect(Array.from(inputs.input_ids.data)).toEqual([0n, 11n, 42n, 7n, 0n]);
        expect(inputs.style.dims).toEqual([1, 256]);
        expect(inputs.style.data[0]).toBe(0);
        expect(inputs.style.data[255]).toBeCloseTo(0.255);
        expect(inputs.speed.data[0]).toBe(1.25);
    });

    test('supports byte offsets in cached, sliced binary voice assets', () => {
        const bytes = new Uint8Array(7 + voiceFixture().length);
        bytes.set(voiceFixture(), 7);
        expect(styleForLength(bytes.subarray(7), 3)[255]).toBeCloseTo(0.255);
    });

    test('strict input size and padding constraints', () => {
        expect(() => prepareKokoroOnnxInputs([], voiceFixture())).toThrow();
        expect(() => prepareKokoroOnnxInputs(new Array(511).fill(2), voiceFixture())).toThrow();
        expect(() => prepareKokoroOnnxInputs([0], voiceFixture())).toThrow();
        expect(() => prepareKokoroOnnxInputs([2.5], voiceFixture())).toThrow();
        expect(() => prepareKokoroOnnxInputs(new DataView(new ArrayBuffer(8)), voiceFixture())).toThrow(/array of phoneme/);
        expect(() => prepareKokoroOnnxInputs([1], voiceFixture(), 0)).toThrow();
        expect(() => prepareKokoroOnnxInputs([1], voiceFixture(), Infinity)).toThrow();
        expect(() => prepareKokoroOnnxInputs([1], voiceFixture(), 5)).toThrow();
        expect(() => prepareKokoroOnnxInputs([2, 3, 4, 5, 6], voiceFixture())).toThrow(/style vector/);
        expect(() => styleForLength(new Uint8Array(5), 1)).toThrow(/256-float/);
        const corrupted = voiceFixture();
        new DataView(corrupted.buffer).setFloat32(3 * 256 * 4, NaN, true);
        expect(() => prepareKokoroOnnxInputs([11, 42, 7], corrupted)).toThrow(/non-finite/);
    });

    test('blends equal-length style vectors with normalized weights (#59)', () => {
        const a = new Float32Array(256);
        const b = new Float32Array(256);
        a[0] = 1;
        b[0] = 5;
        a[10] = 2;
        b[10] = 8;
        const blended = blendStyleVectors([a, b], [1, 3]);
        expect(blended[0]).toBeCloseTo(4);
        expect(blended[10]).toBeCloseTo(6.5);
        expect(() => blendStyleVectors([a], [0])).toThrow(/positive/);
        expect(() => blendStyleVectors([a, b], [1])).toThrow(/align/);
    });

    test('selects per-length styles before blending multiple voice binaries', () => {
        const first = voiceFixture();
        const second = voiceFixture();
        const view = new DataView(second.buffer);
        for (let i = 0; i < 256; i++) {
            view.setFloat32((3 * 256 + i) * 4, 1, true);
        }
        const blended = styleForLengthWeighted([first, second], [1, 1], 3);
        expect(blended[0]).toBeCloseTo(0.5);
        expect(blended[255]).toBeCloseTo((0.255 + 1) / 2);
    });

    test('converts the declared model input contract through an injected official Tensor API', () => {
        class Tensor {
            constructor(type, data, dims) {
                this.type = type;
                this.data = data;
                this.dims = dims;
            }
        }
        const inputs = prepareKokoroOnnxInputs([1, 2, 3], voiceFixture());
        const tensors = asOnnxRuntimeFeeds({ Tensor }, inputs);
        expect(tensors).toEqual({
            input_ids: expect.any(Tensor),
            style: expect.any(Tensor),
            speed: expect.any(Tensor),
        });
        expect(tensors.input_ids.dims).toEqual([1, 5]);
        expect(tensors.style.data).toHaveLength(256);
        expect(() => asOnnxRuntimeFeeds(null, inputs)).toThrow();
        expect(() => asOnnxRuntimeFeeds({ Tensor }, { input_ids: inputs.input_ids })).toThrow();
    });
});
