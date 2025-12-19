import { processContent } from '../text-processor.js';

// Mock findRange since we don't really want to test DOM range finding here
jest.mock('../dom-utils.js', () => ({
    findRange: jest.fn(() => null)
}));

describe('Pronunciation and Math Fixes', () => {
    let segmenter;

    beforeAll(() => {
        // Mock global dependencies
        window.DOMPurify = {
            sanitize: (html) => html
        };

        // Mock minimal compromise (nlp)
        window.nlp = (text) => {
            const doc = {
                contractions: () => ({
                    expand: () => { }
                }),
                text: () => text,
                topics: () => ({
                    out: (format) => {
                        if (format === 'array') {
                            // Extract words starting with capital letters as "topics" for testing
                            // Avoid using \b which fails on non-ASCII characters
                            const regex = /(?:^|[^a-zA-Z0-9\u00C0-\u017F])([A-Z][a-z\u00C0-\u017F]+(?:\s+[A-Z][a-z\u00C0-\u017F]+)*)(?=[^a-zA-Z0-9\u00C0-\u017F]|$)/g;
                            const matches = [];
                            let match;
                            while ((match = regex.exec(text)) !== null) {
                                matches.push(match[1]);
                            }
                            return matches;
                        }
                        return [];
                    }
                })
            };
            return doc;
        };

        // Mock custom pronunciations
        window.kokoroCustomPronunciations = {
            "Hegel": "[Hegel](/hay-gel/)",
            "Gramsci": "[Gramsci](/gram-shee/)",
            "Thomas Aquinas": "[Thomas Aquinas](/tom-as a-kwi-nas/)",
            "Vuk Karadžić": "[Vuk Karadžić](/vook ka-ra-djetch/)"
        };

        // Mock transliterate
        window.transliterate = (text) => text;

        if (typeof Intl.Segmenter !== 'undefined') {
            segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
        } else {
            segmenter = {
                segment: (text) => {
                    const segments = [];
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

    test('Acronyms with plural/possessive (LMs, LLMs, MIT’s)', () => {
        expect(runProcessor('language models (LMs)')).toContain('L M s');
        expect(runProcessor('large language models (LLMs)')).toContain('L L M s');
        expect(runProcessor('MIT’s')).toBe('M I T \'s');
    });

    test('Math equations (y = x)', () => {
        expect(runProcessor('y = x')).toBe('y equals x');
    });

    test('Math powers (x2 − 3xy = z2)', () => {
        // Unicode minus and equals sign
        const output = runProcessor('x2 − 3xy = z2');
        expect(output).toContain('x squared');
        expect(output).toContain('minus 3 x y');
        expect(output).toContain('equals z squared');
    });

    test('Fahrenheit (110° F)', () => {
        expect(runProcessor('110° F')).toBe('110 degrees Fahrenheit');
        expect(runProcessor('110 deg F')).toBe('110 degrees Fahrenheit');
    });

    test('Inches vs in disambiguation', () => {
        // Conflicting "in"
        expect(runProcessor('The box is 10 in. long.')).toContain('10 inches');
        expect(runProcessor('It is in the box.')).not.toContain('inches');
        expect(runProcessor('size is 5 in x 5 in')).toContain('5 inches by 5 inches');
    });

    test('Model names (o1, GPT-4o)', () => {
        expect(runProcessor('OpenAI’s GPT-4o')).toContain('4 o');
        expect(runProcessor('approach the precision of o1')).toContain('o 1');
    });

    test('Name pronunciation (Hegel, Gramsci, Vuk Karadžić)', () => {
        // We expect the text to be wrapped in [Name](/IPA/)
        expect(runProcessor('Hegel argued that...')).toContain('[Hegel](/hay-gel/)');
        expect(runProcessor('Gramsci and state theory')).toContain('[Gramsci](/gram-shee/)');
        expect(runProcessor('Thomas Aquinas wrote')).toContain('[Thomas Aquinas](/tom-as a-kwi-nas/)');
        expect(runProcessor('Vuk Karadžić is a linguist')).toContain('[Vuk Karadzhitsh](/vook ka-ra-djetch/)');
    });
});
