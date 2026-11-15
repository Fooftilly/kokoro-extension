/** @jest-environment node */
import vm from 'node:vm';
import { OnnxKokoroProvider } from '../onnx-provider.js';
import { encodePcm16Wav } from '../pcm-wav.js';

// Exercise the provider's output boundary without loading model weights or SDKs.
function providerFor(audio) {
    const provider = new OnnxKokoroProvider();
    provider.session = {
        outputNames: ['audio'],
        run: jest.fn(async () => ({ audio })),
    };
    provider.engine = {
        Tensor: class {
            constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
        },
    };
    provider.voice = new Uint8Array(4 * 256 * 4);
    return provider;
}

describe('ONNX output validation across JavaScript realms (#60)', () => {
    test('accepts foreign-realm Float32 PCM through the provider and WAV encoder', async () => {
        const samples = vm.runInNewContext('new Float32Array([0.2, -0.3, 0.1])');
        expect(samples instanceof Float32Array).toBe(false);
        const provider = providerFor({ data: samples, dims: [1, 3] });
        const result = await provider.synthesizePhonemes('a b');
        expect(result.samples).toBe(samples);
        expect(result.sampleRateHz).toBe(24000);
        const wav = encodePcm16Wav(result.samples, result.sampleRateHz);
        expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe('RIFF');
        expect(wav.byteLength).toBe(44 + 2 * samples.length);
    });

    test.each([
        ['integer PCM', 'new Int32Array([1, -1])'],
        ['64-bit PCM', 'new Float64Array([0.2, -0.2])'],
        ['ordinary arrays', '[0.2, -0.2]'],
        ['non-finite PCM', 'new Float32Array([NaN, 0.2])'],
        ['silent PCM', 'new Float32Array([0, 0])'],
    ])('rejects foreign-realm %s', async (_name, expression) => {
        const provider = providerFor({ data: vm.runInNewContext(expression), dims: [1, 2] });
        await expect(provider.synthesizePhonemes('a b')).rejects.toThrow();
    });

    test.each([
        undefined,
        { dims: [1, 2] },
        { data: new Float32Array() , dims: [1, 0] },
        { data: new Float32Array([0.2, -0.2]) },
        { data: new Float32Array([0.2, -0.2]), dims: [1, 3] },
    ])('rejects missing, empty or mismatched graph outputs: %j', async audio => {
        await expect(providerFor(audio).synthesizePhonemes('a b')).rejects.toThrow();
    });
});
