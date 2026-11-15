/** @jest-environment node */
import { OnnxKokoroProvider } from '../onnx-provider.js';
import { parseEnglishLexicon } from '../english-g2p.js';

const dictionary = () => parseEnglishLexicon('hello HH AH0 L OW1\nworld W ER1 L D');

function fixture(loadDictionary = jest.fn(async () => dictionary())) {
    const fetchImpl = jest.fn();
    const loadSDK = jest.fn();
    const cacheStorage = { open: jest.fn() };
    const provider = new OnnxKokoroProvider({ loadDictionary, fetchImpl, loadSDK, cacheStorage });
    return { provider, loadDictionary, fetchImpl, loadSDK, cacheStorage };
}

describe('ONNX English validation before model allocation (#60)', () => {
    test.each([
        ['unknown word', 'unknown', /Missing English pronunciation/],
        ['unsupported script', 'привет', /Unsupported English text/],
        ['unsupported number', 'hello 123', /Unsupported English text/],
        ['token overflow', 'hello '.repeat(130), /at most 510/],
    ])('rejects %s without reading model bytes or loading WASM', async (_name, text, error) => {
        const { provider, loadDictionary, cacheStorage, loadSDK, fetchImpl } = fixture();
        await expect(provider.synthesize(text)).rejects.toThrow(error);
        expect(loadDictionary).toHaveBeenCalledTimes(1);
        expect(cacheStorage.open).not.toHaveBeenCalled();
        expect(loadSDK).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(provider.session).toBeNull();
    });

    test('a missing dictionary fails before loading the model and can be retried', async () => {
        const loadDictionary = jest.fn()
            .mockRejectedValueOnce(new Error('English dictionary not installed'))
            .mockResolvedValueOnce(dictionary());
        const { provider, cacheStorage, loadSDK, fetchImpl } = fixture(loadDictionary);
        await expect(provider.synthesize('Hello')).rejects.toThrow(/dictionary not installed/);
        expect(cacheStorage.open).not.toHaveBeenCalled();
        expect(loadSDK).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        // Valid text still reaches the ordinary, model-backed synthesis method.
        const synthesis = jest.spyOn(provider, 'synthesizePhonemes').mockResolvedValue('audio');
        await expect(provider.synthesize('Hello', { speed: 1.25 })).resolves.toBe('audio');
        expect(loadDictionary).toHaveBeenCalledTimes(2);
        expect(synthesis).toHaveBeenCalledWith('həlˈoʊ', { speed: 1.25 });
    });

    test('supported text reaches model initialization after successful tokenization', async () => {
        const { provider, loadDictionary, cacheStorage, fetchImpl } = fixture();
        const initialized = jest.spyOn(provider, 'initialize').mockImplementation(async () => {
            expect(provider.dictionary).toBeInstanceOf(Map);
            throw new Error('Model initialization reached');
        });
        await expect(provider.synthesize('Hello world.')).rejects.toThrow('Model initialization reached');
        expect(initialized).toHaveBeenCalledTimes(1);
        expect(loadDictionary).toHaveBeenCalledTimes(1);
        expect(cacheStorage.open).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
