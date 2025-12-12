import { processContent } from '../text-processor.js';

// Mock findRange since we don't really want to test DOM range finding here
jest.mock('../dom-utils.js', () => ({
    findRange: jest.fn(() => null)
}));

describe('processContent Regressions', () => {
    let segmenter;

    beforeAll(() => {
        // Mock global dependencies
        window.DOMPurify = {
            sanitize: (html) => html
        };

        // Mock minimal compromise (nlp)
        window.nlp = (text) => ({
            contractions: () => ({
                expand: () => { }
            }),
            text: () => text
        });

        // Mock transliterate
        window.transliterate = (text) => text;

        // Use real Intl.Segmenter if available (Node 16+)
        if (typeof Intl.Segmenter !== 'undefined') {
            segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
        } else {
            // Fallback mock check for sentence splitting
            segmenter = {
                segment: (text) => {
                    // Simple distinct sentence splitter for test env without Intl
                    // This is rough but should capture basic "Feb." vs "2011" if we split strictly.
                    // But for "Levels of CO2 are rising.", it is one sentence.
                    // Let's just return the whole text as one segment if it's simple, 
                    // or split by explicit period space.
                    const segments = [];
                    // Simplistic split looking for ". "
                    let parts = text.split(/([.!?]\s+)/);
                    let index = 0;
                    for (let i = 0; i < parts.length; i += 2) {
                        let seg = parts[i];
                        if (parts[i + 1]) seg += parts[i + 1];
                        if (seg) {
                            segments.push({ segment: seg, index: index, input: text });
                            index += seg.length;
                        }
                    }
                    return segments;
                }
            };
        }
    });

    const runProcessor = (text) => {
        const blocks = [{ type: 'text', content: text }];
        const result = processContent(blocks, segmenter);
        return result.sentences.map(s => s.text).join(' ');
    };

    test('Regression: Chemical formulas (CO2)', () => {
        const output = runProcessor('Levels of CO2 are rising.');
        expect(output).toMatch(/carbon dioxide/i);
    });

    test('Regression: Fractions (1/2)', () => {
        const output = runProcessor('Add 1/2 cup of sugar.');
        expect(output).toMatch(/1 half/i);
    });

    test('Regression: Dates (Feb. 2011)', () => {
        const output = runProcessor('Back in Feb. 2011.');
        expect(output).toMatch(/February 2011/i);
    });

    test('Regression: Units (μm)', () => {
        const output = runProcessor('The size is 5 μm.');
        expect(output).toMatch(/5 micrometers/i);
    });

    test('Regression: Temperature (degrees C)', () => {
        const output = runProcessor('It is 25°C outside.');
        expect(output).toMatch(/25 degrees Celsius/i);
    });

    test('Regression: Roman Numerals (Henry VIII)', () => {
        const output = runProcessor('Henry VIII was a king.');
        expect(output).toMatch(/Henry the eighth/i);
    });

    test('Feature: Em-Dash Pause', () => {
        const output = runProcessor('Wait—there is more.');
        // Expect em-dash to be replaced by comma to induce pause
        expect(output).toMatch(/Wait, there is more/);
    });

    test('Feature: Sentence Merging - Abbreviations', () => {
        // "Dr. Smith" might be split by tokenizer as "Dr." and "Smith". Processor should merge.
        // We force a split case by passing segments if we were mocking segments directly, 
        // but here we rely on the mocked (or real) segmenter behavior on the input string.
        // If "Dr. Smith" is passed, our mock segmenter might split it if we wrote it as "Dr. Smith".
        // Let's ensure the processor output is a SINGLE sentence.

        const blocks = [{ type: 'text', content: 'Dr. Smith is here.' }];
        const result = processContent(blocks, segmenter);
        expect(result.sentences.length).toBe(1);
        expect(result.sentences[0].text).toBe('Dr. Smith is here.');
    });

    test('Feature: Sentence Merging - Initials', () => {
        const blocks = [{ type: 'text', content: 'J. R. R. Tolkien.' }];
        const result = processContent(blocks, segmenter);
        expect(result.sentences.length).toBe(1);
    });

    // Snapshot of a complex paragraph to catch any unintended changes in normalization
    test('Snapshot: Complex Scientific Text', () => {
        const text = `
            Fig. 1 shows that CO2 levels increased by 50% (approx. 200 ppm).
            The temp. reached 25°C.
            Henry VIII died in Jan. 1547.
            See e.g. Smith et al. (2020) for more details.
        `.trim().replace(/\s+/g, ' '); // Normalize input whitespace

        const output = runProcessor(text);
        expect(output).toMatchSnapshot();
    });
});
