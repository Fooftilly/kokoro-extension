/** @jest-environment node */
import { OnnxKokoroProvider } from '../onnx-provider.js';
import { parseEnglishLexicon, phonemizeEnglish, phonemizeEnglishChunks } from '../english-g2p.js';
import { tokenizePhonemes } from '../phoneme-tokenizer.js';

const dictionary = () => parseEnglishLexicon('hello HH AH0 L OW1\nworld W ER1 L D\nagain AH0 G EH1 N');
const longText = () => Array(74).fill('hello').join(' ') + '.';
const pcm = n => ({ audio: { data: new Float32Array([n / 10, -n / 10]), dims: [1, 2] } });
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
function fixture() {
    const lexicon = dictionary();
    const provider = new OnnxKokoroProvider({ loadDictionary: async () => lexicon });
    let calls = 0;
    const session = {
        outputNames: ['audio'],
        run: jest.fn(async () => pcm(++calls)),
        release: jest.fn(async () => {}),
    };
    const floats = new Float32Array(512 * 256);
    for (let row = 0; row < 512; row++) floats.fill(row / 512, row * 256, (row + 1) * 256);
    const load = jest.spyOn(provider, 'loadEngine').mockImplementation(async () => {
        provider.session = session;
        provider.voice = new Uint8Array(floats.buffer);
        provider.engine = { Tensor: class {
            constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
        } };
    });
    return { provider, session, load, lexicon };
}

describe('dictionary-supported English chunk preparation (#60)', () => {
    test('short text retains exactly the existing phonemes and punctuation', () => {
        for (const text of ['Hello world.', '“Hello,” (world)! Hello again?', 'hello—world: hello; world.']) {
            expect(phonemizeEnglishChunks(text, dictionary())).toEqual([phonemizeEnglish(text, dictionary())]);
        }
    });

    test('splits at whole-word boundaries and retains every word and final punctuation', () => {
        const chunks = phonemizeEnglishChunks(longText(), dictionary());
        expect(chunks).toHaveLength(2);
        expect(chunks.map(chunk => tokenizePhonemes(chunk).length)).toEqual([510, 7]);
        expect(chunks.join(' ')).toBe(Array(74).fill('həlˈoʊ').join(' ') + '.');
        expect(chunks[0].split(' ')).toHaveLength(73);
        expect(chunks[1]).toBe('həlˈoʊ.');
    });

    test('does not separate closing punctuation from a word at the graph limit', () => {
        const text = Array(73).fill('hello').join(' ') + '. Hello world!';
        const chunks = phonemizeEnglishChunks(text, dictionary());
        expect(chunks).toHaveLength(2);
        expect(chunks[1].startsWith('həlˈoʊ. ')).toBe(true);
        for (const chunk of chunks) expect(tokenizePhonemes(chunk).length).toBeLessThanOrEqual(510);
    });

    test.each(['unknown', 'hello 123', 'привет', 'hello 😀'])('rejects unsupported text anywhere: %s', text => {
        expect(() => phonemizeEnglishChunks(longText() + ' ' + text, dictionary())).toThrow();
    });

    test('rejects a pronunciation group that cannot fit into a graph', () => {
        const lexicon = new Map([['huge', Array(511).fill('B').join(' ')]]);
        expect(() => phonemizeEnglishChunks('huge', lexicon)).toThrow(/510/);
    });

    test('Bella-sized voices cap chunks at 509 phonemes', () => {
        // af_bella.bin is 522240 bytes → 510 style rows → max index 509.
        expect(phonemizeEnglishChunks(longText(), dictionary(), 510)
            .map(chunk => tokenizePhonemes(chunk).length)).toEqual([510, 7]);
        const at509 = phonemizeEnglishChunks(longText(), dictionary(), 509)
            .map(chunk => tokenizePhonemes(chunk).length);
        expect(at509.every(count => count <= 509)).toBe(true);
        expect(Math.max(...at509)).toBeLessThan(510);
        const lexicon = new Map([['huge', Array(510).fill('B').join(' ')]]);
        expect(() => phonemizeEnglishChunks('huge', lexicon, 509)).toThrow(/509/);
        expect(() => phonemizeEnglishChunks('huge', lexicon, 510)).not.toThrow();
    });
});

describe('bounded, cancellable ONNX long-text inference (#60)', () => {
    test('long supported text uses ordered graph runs and correct per-length styles in one session', async () => {
        const { provider, session, load } = fixture();
        const result = await provider.synthesize(longText(), { speed: 1.25 });
        expect(load).toHaveBeenCalledTimes(1);
        expect(session.run).toHaveBeenCalledTimes(2);
        expect(result.sampleRateHz).toBe(24000);
        expect(Array.from(result.samples)).toEqual(Array.from(new Float32Array([0.1, -0.1, 0.2, -0.2])));
        const feeds = session.run.mock.calls.map(([feed]) => feed);
        expect(feeds.map(feed => feed.input_ids.dims)).toEqual([[1, 512], [1, 9]]);
        expect(feeds.map(feed => feed.style.data[0])).toEqual([510 / 512, 7 / 512]);
        expect(feeds.map(feed => feed.speed.data[0])).toEqual([1.25, 1.25]);
        for (const feed of feeds) {
            expect(feed.input_ids.data[0]).toBe(0n);
            expect(feed.input_ids.data[feed.input_ids.data.length - 1]).toBe(0n);
        }
    });

    test('a late unknown word fails before model initialization or any partial inference', async () => {
        const { provider, load, session } = fixture();
        await expect(provider.synthesize(longText() + ' unknown')).rejects.toThrow(/Missing English pronunciation/);
        expect(load).not.toHaveBeenCalled();
        expect(session.run).not.toHaveBeenCalled();
    });

    test('cancel waits for the active native run but discards its PCM and skips remaining chunks', async () => {
        const { provider, session, load } = fixture();
        const started = deferred();
        const finished = deferred();
        session.run.mockImplementationOnce(() => { started.resolve(); return finished.promise; });
        const synthesis = provider.synthesize(longText());
        await started.promise;
        await provider.cancel();
        finished.resolve(pcm(1));
        await expect(synthesis).rejects.toMatchObject({ name: 'AbortError' });
        expect(session.run).toHaveBeenCalledTimes(1);
        expect(session.release).not.toHaveBeenCalled();
        await expect(provider.synthesize('Hello world.')).resolves.toMatchObject({ sampleRateHz: 24000 });
        expect(load).toHaveBeenCalledTimes(1);
        expect(session.run).toHaveBeenCalledTimes(2);
    });

    test('cancel during dictionary loading prevents model startup', async () => {
        const { provider, load } = fixture();
        const finished = deferred();
        provider.loadDictionary = () => finished.promise;
        const synthesis = provider.synthesize(longText());
        await provider.cancel();
        finished.resolve(dictionary());
        await expect(synthesis).rejects.toMatchObject({ name: 'AbortError' });
        expect(load).not.toHaveBeenCalled();
    });

    test('cancel during model startup prevents the first native run', async () => {
        const { provider, session, load } = fixture();
        const started = deferred();
        const finished = deferred();
        const original = load.getMockImplementation();
        load.mockImplementation(async () => { started.resolve(); await finished.promise; await original(); });
        const synthesis = provider.synthesize(longText());
        await started.promise;
        await provider.cancel();
        finished.resolve();
        await expect(synthesis).rejects.toMatchObject({ name: 'AbortError' });
        expect(session.run).not.toHaveBeenCalled();
    });

    test('malformed PCM from a later chunk prevents a partial successful response', async () => {
        const { provider, session } = fixture();
        session.run.mockResolvedValueOnce(pcm(1))
            .mockResolvedValueOnce({ audio: { data: new Float32Array([NaN]), dims: [1, 1] } });
        await expect(provider.synthesize(longText())).rejects.toThrow(/finite/);
        expect(session.run).toHaveBeenCalledTimes(2);
    });

    test('combined audio obeys the existing ten-minute PCM bound', async () => {
        const { provider, session } = fixture();
        session.run.mockResolvedValueOnce({
            audio: { data: new Float32Array(24000 * 60 * 10).fill(0.1), dims: [1, 24000 * 60 * 10] },
        });
        await expect(provider.synthesize(longText())).rejects.toThrow(/ten.minute/);
        expect(session.run).toHaveBeenCalledTimes(2);
    });

    test.each([0, -1, 5, NaN, Infinity])('invalid speed %s fails before dictionary/model loading', async speed => {
        const { provider, load } = fixture();
        const dictionaryLoad = jest.spyOn(provider, 'loadDictionary');
        await expect(provider.synthesize(longText(), { speed })).rejects.toThrow(/speed/);
        await expect(provider.synthesizePhonemes('hɛˈloʊ.', { speed })).rejects.toThrow(/speed/);
        expect(dictionaryLoad).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
    });
});
