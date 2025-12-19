/**
 * @jest-environment jsdom
 */
const { Readability } = require('@mozilla/readability');

describe('Code Block Support', () => {
    let parseArticle;

    beforeAll(() => {
        global.Readability = Readability;
        global.browser = {
            runtime: {
                onMessage: {
                    addListener: jest.fn()
                }
            }
        };
        const contentModule = require('../content.js');
        parseArticle = contentModule.parseArticle;
    });

    test('should extract code blocks from <pre> tags', async () => {
        document.body.innerHTML = `
            <article>
                <h1>Article Title</h1>
                <p>Intro paragraph.</p>
                <pre><code>const x = 10;
console.log(x);</code></pre>
            </article>
        `;

        const result = await parseArticle(document);
        expect(result.content).toBeDefined();

        const codeBlock = result.content.find(b => b.type === 'code');
        expect(codeBlock).toBeDefined();
        expect(codeBlock.content).toContain('const x = 10;');
        expect(codeBlock.content).toContain('console.log(x);');
    });

    test('should extract code blocks from <pre> tags without <code> inner tag', async () => {
        document.body.innerHTML = `
            <article>
                <h1>Article Title</h1>
                <p>Intro paragraph.</p>
                <pre>simple pre text</pre>
            </article>
        `;

        const result = await parseArticle(document);
        expect(result.content).toBeDefined();

        const codeBlock = result.content.find(b => b.type === 'code');
        expect(codeBlock).toBeDefined();
        expect(codeBlock.content).toBe('simple pre text');
    });
});
