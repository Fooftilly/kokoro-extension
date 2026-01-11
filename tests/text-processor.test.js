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
            text: () => text,
            topics: () => ({
                out: () => []
            })
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
        // Must be normalized client-side because transliteration converts μm -> mm (error)
        expect(output).toMatch(/5 micrometers/i);
    });

    test('Regression: Units with Micro Sign (U+00B5)', () => {
        // \u00B5 is the Micro Sign, distinct from \u03BC (Greek Small Letter Mu)
        const output = runProcessor('The size is 10\u00B5m.');
        expect(output).toMatch(/10 micrometers/i);
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

    test('Regression: Abbreviation no. (Number)', () => {
        const output = runProcessor('issue no. 253');
        expect(output).toMatch(/issue Number 253/i);
    });

    test('Regression: Abbreviation pp. (pages)', () => {
        const output = runProcessor('See pp. 45–77.'); // en-dash
        expect(output).toMatch(/See pages 45 to 77/i);
    });

    test('Regression: Abbreviation p. (page)', () => {
        const output = runProcessor('See p. 45.');
        expect(output).toMatch(/See page 45/i);
    });

    test('Feature: Blockquote Property Propagation', () => {
        const blocks = [{ type: 'text', content: 'Quoted text', isQuote: true }];
        const result = processContent(blocks, segmenter);
        expect(result.renderData[0].isQuote).toBe(true);
    });

    test('Feature: Decade Pronunciation (1940s)', () => {
        const output = runProcessor('In the 1940s there was...');
        // Should NOT be "1940 s"
        expect(output).toMatch(/1940s/);
        expect(output).not.toMatch(/1940 s/);
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

    test('Regression: No split on possessive (Dedekind’s)', () => {
        const blocks = [{ type: 'text', content: 'This is unrelated to Dedekind’s work.' }];
        const result = processContent(blocks, segmenter);
        expect(result.sentences.length).toBe(1);
        expect(result.sentences[0].text).toContain("Dedekind’s work");
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

    test('Feature: Roman Numerals with Suffix', () => {
        const output = runProcessor('Plate XXVIIIa shows the details.');
        expect(output).toMatch(/twenty-eight a/i);
    });

    test('Feature: Date Ranges Expansion', () => {
        const output = runProcessor('The period 1990–91 was critical.');
        expect(output).toMatch(/1990 to 1991/i);
    });

    test('Feature: Date Pronunciation (22 June 1915)', () => {
        expect(runProcessor('Born on 22 June 1915.')).toMatch(/the 22nd of June, 1915/i);
        expect(runProcessor('On 1 Jan 2000.')).toMatch(/the 1st of January, 2 thousand/i);
        expect(runProcessor('The 3rd of May.')).not.toMatch(/the 3rdrd of May/); // Check no double ordinals if it was already ordinal (though rule targets \d+)
        expect(runProcessor('Since Dec. 16, it happened.')).toMatch(/Since December 16th, it happened/i);
    });

    test('Feature: Sentence Splitting (Month Abbreviations)', () => {
        // This tests that "Dec." doesn't split the sentence
        const result = runProcessor('Since Dec. 16, Shasta has risen.');
        expect(result).toMatch(/December 16th/);
    });

    test('Feature: ISO 8601 Dates (2023-12-25)', () => {
        expect(runProcessor('Date: 2023-12-25')).toMatch(/the 25th of December, 2023/i);
    });

    test('Feature: Month Day Year Dates (Dec 25 2023)', () => {
        expect(runProcessor('On Dec 25, 2023')).toMatch(/the 25th of December, 2023/i);
        expect(runProcessor('On December 25 2023')).toMatch(/the 25th of December, 2023/i);
        expect(runProcessor('On Jan. 1, 2000')).toMatch(/the 1st of January, 2 thousand/i); // 2000 becomes 2 thousand
    });

    test('Feature: Scientific Units (mW/m2 vs MW/m2)', () => {
        const output1 = runProcessor('Intensity is 5 mW/m2.');
        expect(output1).toMatch(/5 milliwatts per square meter/i);
        const output2 = runProcessor('Power is 5 MW/m2.');
        expect(output2).toMatch(/5 megawatts per square meter/i);
    });

    test('Feature: Case-sensitive unit expansion (MW vs mW, MJ vs mJ)', () => {
        expect(runProcessor('10 MW')).toMatch(/10 megawatts/i);
        expect(runProcessor('10 mW')).toMatch(/10 milliwatts/i);
        expect(runProcessor('10 MJ')).toMatch(/10 megajoules/i);
        expect(runProcessor('10 mJ')).toMatch(/10 millijoules/i);
        expect(runProcessor('10 mj')).toMatch(/10 millijoules/i); // Explicitly handled
    });

    test('Feature: Negative Numbers', () => {
        const output = runProcessor('The temperature drops to -5 degrees Celsius.');
        // The processor replaces "-" with "minus " for degrees Celsius specifically in line 125
        expect(output).toMatch(/minus 5 degrees Celsius/i);
    });

    test('Feature: Cubic Meters', () => {
        const output = runProcessor('Volume is 10 m3.');
        expect(output).toMatch(/10 cubic meters/i);
    });

    test('Feature: Velocity', () => {
        const output = runProcessor('Speed is 30 m/s.');
        expect(output).toMatch(/30 meters per second/i);
    });

    test('Feature: Dimensions (20 cm × 8 cm)', () => {
        const output = runProcessor('size being 20 cm × 8 cm (8 in × 3 in)');
        // 20 cm x 8 cm -> 20 centimeters by 8 centimeters
        // 8 in x 3 in -> 8 inches by 3 inches
        expect(output).toMatch(/20 centimeters by 8 centimeters/i);
        expect(output).toMatch(/8 inches by 3 inches/i);
    });

    test('Feature: Dimensions with "x" (20x20)', () => {
        const output = runProcessor('Resolution 1920x1080 and 4 x 4.');
        expect(output).toMatch(/1920 by 1080/);
        expect(output).toMatch(/4 by 4/);
    });

    test('Feature: Dimensions hex safeguard', () => {
        const output = runProcessor('Address 0x10 is invalid.');
        // Should NOT be "0 by 10"
        expect(output).toMatch(/0x10/);
        expect(output).not.toMatch(/0 by 10/);
    });
});
