import nlp from 'compromise';
import {
    processContent,
    expandContractionsSafely,
    formatInitialismWithSuffix
} from '../text-processor.js';

jest.mock('../dom-utils.js', () => ({
    findRange: jest.fn(() => null)
}));

describe('Stage 3: possessive \'s (#7) and plural initialisms (#8)', () => {
    let segmenter;

    beforeAll(() => {
        window.DOMPurify = { sanitize: (html) => html };
        window.nlp = nlp;
        window.transliterate = (text) => text;

        if (typeof Intl.Segmenter !== 'undefined') {
            segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
        } else {
            segmenter = {
                segment: (text) => [{ segment: text, index: 0, input: text }]
            };
        }
    });

    const runProcessor = (text) => {
        const blocks = [{ type: 'text', content: text }];
        const result = processContent(blocks, segmenter);
        return result.sentences.map(s => s.text).join(' ');
    };

    describe('expandContractionsSafely (#7)', () => {
        test('does not expand Perseverance\'s before a capitalized gerund', () => {
            const out = expandContractionsSafely("Perseverance's Scanning Habitable Environments");
            expect(out).toContain("Perseverance's");
            expect(out).not.toMatch(/Perseverance is/i);
        });

        test('preserves curly apostrophe possessives', () => {
            const out = expandContractionsSafely('Perseverance\u2019s Scanning Habitable Environments');
            expect(out).toContain('Perseverance\u2019s');
            expect(out).not.toMatch(/Perseverance is/i);
        });

        test('still expands recognized contractions', () => {
            expect(expandContractionsSafely("It's raining.")).toMatch(/It is raining/);
            expect(expandContractionsSafely("that's fine")).toMatch(/that is fine/i);
            expect(expandContractionsSafely("She's here")).toMatch(/She is here/);
            expect(expandContractionsSafely("don't worry")).toMatch(/do not worry/i);
            expect(expandContractionsSafely("I'm ready")).toMatch(/I am ready/);
            expect(expandContractionsSafely("they're late")).toMatch(/they are late/i);
            expect(expandContractionsSafely("we'll see")).toMatch(/we will see/i);
            expect(expandContractionsSafely("I've been")).toMatch(/I have been/);
            expect(expandContractionsSafely("Let's go")).toMatch(/Let us go/);
        });

        test('leaves ordinary possessives possessive', () => {
            expect(expandContractionsSafely("John's hat is on the table.")).toContain("John's");
            expect(expandContractionsSafely("the company's policy")).toContain("company's");
            expect(expandContractionsSafely("NASA's rover")).toContain("NASA's");
        });

        test('protects ALLCAPS initialism possessives even when base is a safe contraction', () => {
            expect(expandContractionsSafely("IT's design")).toContain("IT's");
            expect(expandContractionsSafely("IT's design")).not.toMatch(/\bIT is\b/);
            expect(expandContractionsSafely("LLM's design")).toContain("LLM's");
            expect(expandContractionsSafely("LLM's design")).not.toMatch(/\bLLM is\b/);
            // Normal title/lower contractions must still expand
            expect(expandContractionsSafely("It's raining.")).toMatch(/It is raining/);
            expect(expandContractionsSafely("it's raining.")).toMatch(/it is raining/i);
        });

        test('protects Unicode possessive bases (accented names)', () => {
            expect(expandContractionsSafely("Renée's Scanning Habitable Environments")).toContain("Renée's");
            expect(expandContractionsSafely("Renée's Scanning Habitable Environments")).not.toMatch(/Renée is/i);
            expect(expandContractionsSafely('Renée\u2019s Scanning Habitable Environments')).toContain('Renée\u2019s');
            expect(expandContractionsSafely('Renée\u2019s Scanning Habitable Environments')).not.toMatch(/Renée is/i);
            // Accented name that raw compromise can mis-expand when unprotected
            expect(expandContractionsSafely("Élodie's Garden Scanning")).toContain("Élodie's");
            expect(expandContractionsSafely("Élodie's Garden Scanning")).not.toMatch(/Elodie is|Élodie is/i);
        });

        test('raw compromise still mis-expands Perseverance\'s (documents root cause)', () => {
            const doc = nlp("Perseverance's Scanning Habitable Environments");
            doc.contractions().expand();
            expect(doc.text()).toMatch(/Perseverance is/);
        });
    });

    describe('formatInitialismWithSuffix (#8)', () => {
        test('glues plural s to the last letter', () => {
            expect(formatInitialismWithSuffix('MMC', 's')).toBe('M M Cs');
            expect(formatInitialismWithSuffix('LLM', 's')).toBe('L L Ms');
            expect(formatInitialismWithSuffix('LM', 's')).toBe('L Ms');
        });

        test('keeps possessive space-separated and normalizes apostrophe', () => {
            expect(formatInitialismWithSuffix('MMC', "'s")).toBe("M M C 's");
            expect(formatInitialismWithSuffix('MMC', '\u2019s')).toBe("M M C 's");
            expect(formatInitialismWithSuffix('MIT', '\u2019s')).toBe("M I T 's");
        });
    });

    describe('processContent integration', () => {
        test('#7: Perseverance\'s stays possessive through the full pipeline', () => {
            const out = runProcessor("Perseverance's Scanning Habitable Environments");
            expect(out).toContain("Perseverance's");
            expect(out).not.toMatch(/Perseverance is/i);
        });

        test('#7: curly Perseverance’s stays possessive', () => {
            const out = runProcessor('Perseverance\u2019s Scanning Habitable Environments');
            expect(out).toMatch(/Perseverance[\u2019']s/);
            expect(out).not.toMatch(/Perseverance is/i);
        });

        test('#7: recognized contractions still normalize in processContent', () => {
            expect(runProcessor("It's raining today.")).toMatch(/It is raining/i);
            expect(runProcessor("That's enough.")).toMatch(/That is enough/i);
        });

        test('#8: plural initialisms attach s to last letter', () => {
            expect(runProcessor('The MMCs were analyzed.')).toMatch(/M M Cs/);
            expect(runProcessor('The MMCs were analyzed.')).not.toMatch(/M M C s\b/);
            expect(runProcessor('LMs and LLMs.')).toMatch(/L Ms and L L Ms/);
        });

        test('#8: possessive initialisms stay distinct from plurals', () => {
            expect(runProcessor("MMC's design")).toMatch(/M M C 's/);
            expect(runProcessor('MMC\u2019s design')).toMatch(/M M C 's/);
            expect(runProcessor("MMC's design")).not.toMatch(/M M Cs\b/);
        });

        test('#7/#8: ALLCAPS allowlist collision still reaches initialism possessive formatting', () => {
            expect(runProcessor("IT's design")).toMatch(/I T 's/);
            expect(runProcessor("IT's design")).not.toMatch(/\bIT is\b/);
            expect(runProcessor("LLM's design")).toMatch(/L L M 's/);
        });

        test('#7: Unicode possessives survive processContent', () => {
            const out = runProcessor("Renée's Scanning Habitable Environments");
            expect(out).toMatch(/Renée'?s|Renee'?s/);
            expect(out).not.toMatch(/Renée is|Renee is/i);
        });

        test('#8: non-plural acronyms and ordinary plurals unchanged in intent', () => {
            // Plain MMC without s/s' is not rewritten by the plural/possessive rule
            expect(runProcessor('The MMC was analyzed.')).toContain('MMC');
            expect(runProcessor('The cats were analyzed.')).toContain('cats');
        });

        test('pipeline order: contraction expand then acronym plural/possessive', () => {
            const out = runProcessor("It's clear the MMCs and NASA's rover matter.");
            expect(out).toMatch(/It is clear/);
            expect(out).toMatch(/M M Cs/);
            expect(out).toMatch(/N A S A 's/);
        });

        test('punctuation and sentence boundaries around plural initialisms', () => {
            expect(runProcessor('See the MMCs.')).toMatch(/M M Cs\./);
            expect(runProcessor('MMCs, LLMs, and more.')).toMatch(/M M Cs, L L Ms/);
        });
    });
});
