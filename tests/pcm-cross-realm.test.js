const vm = require('node:vm');
const { validateKokoroPcm, encodePcm16Wav } = require('../pcm-wav.js');

describe('Kokoro PCM validation across browser JavaScript realms', () => {
    test('accepts a genuine foreign-realm Float32Array and encodes valid WAV', () => {
        const foreignSamples = vm.runInNewContext(
            'new Float32Array([0.2, -0.25, 0.3, -0.15])'
        );
        expect(ArrayBuffer.isView(foreignSamples)).toBe(true);
        expect(foreignSamples instanceof Float32Array).toBe(false);
        const validated = validateKokoroPcm(foreignSamples, 24000);
        expect(validated.samples).toBe(foreignSamples);
        expect(validated.rms).toBeGreaterThan(0.0001);
        const wav = encodePcm16Wav(foreignSamples, 24000);
        expect(wav).toBeInstanceOf(Uint8Array);
        expect(wav.byteLength).toBe(44 + foreignSamples.length * 2);
        const header = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
        expect(header.getUint32(24, true)).toBe(24000);
        expect(header.getUint32(40, true)).toBe(foreignSamples.length * 2);
    });

    test('continues rejecting integer, 64-bit and ordinary array samples', () => {
        for (const invalid of [
            new Uint32Array([3, 4]),
            new Float64Array([0.2]),
            vm.runInNewContext('new Int32Array([3])'),
            [0.1, -0.1],
            null,
        ]) {
            expect(() => validateKokoroPcm(invalid, 24000)).toThrow(/Expected Kokoro Float32 PCM/);
            expect(() => encodePcm16Wav(invalid, 24000)).toThrow(/Expected a nonempty, bounded Float32Array/);
        }
    });

    test('reports wrong sample rate and empty samples distinctly', () => {
        expect(() => validateKokoroPcm(new Float32Array([0.2]), 44100))
            .toThrow(/sampleRateHz=44100/);
        expect(() => validateKokoroPcm(new Float32Array(), 24000))
            .toThrow(/length=0/);
    });

    test('continues rejecting NaN, Infinity, and silence', () => {
        expect(() => validateKokoroPcm(new Float32Array([NaN]), 24000))
            .toThrow(/PCM sample must be finite/);
        expect(() => validateKokoroPcm(new Float32Array([Infinity]), 24000))
            .toThrow(/PCM sample must be finite/);
        expect(() => validateKokoroPcm(new Float32Array([0, 0]), 24000))
            .toThrow(/silent or near-silent PCM/);
    });
});
