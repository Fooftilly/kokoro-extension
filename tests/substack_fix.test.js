/**
 * @jest-environment jsdom
 */
const { Readability } = require('@mozilla/readability');

describe('Substack Fixes', () => {
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

    test('should NOT duplicate text when LI contains P', async () => {
        document.body.innerHTML = `
            <article>
                <h1>Article Title</h1>
                <p>Intro paragraph to make it look like an article.</p>
                <ul>
                    <li>
                        <p>This is a list item sentence.</p>
                    </li>
                </ul>
            </article>
        `;

        const result = await parseArticle(document);
        expect(result.content).toBeDefined();

        // Find list items
        const listItems = result.content.filter(b => b.type === 'list-item');
        expect(listItems.length).toBe(1);
        expect(listItems[0].content).toBe('This is a list item sentence.');

        // Ensure no separate paragraph block for the same text
        const paragraphs = result.content.filter(b => b.type === 'text');
        const duplicate = paragraphs.find(p => p.content.includes('This is a list item sentence.'));
        expect(duplicate).toBeUndefined();
    });

    test('should extract high-quality image from srcset or data-src', async () => {
        document.body.innerHTML = `
            <article>
                <h1>Article Title</h1>
                <p>Intro paragraph.</p>
                <picture>
                    <img 
                        src="placeholder.jpg" 
                        data-src="high-res.jpg"
                        srcset="small.jpg 400w, large.jpg 1200w"
                    />
                </picture>
            </article>
        `;

        const result = await parseArticle(document);
        expect(result.content).toBeDefined();
        const img = result.content.find(b => b.type === 'image');
        expect(img).toBeDefined();
        // Since we take the last item of srcset if available
        expect(img.src).toContain('large.jpg');
    });

    test('should fallback to data-src if no srcset', async () => {
        document.body.innerHTML = `
            <article>
                <h1>Article Title</h1>
                <p>Intro paragraph.</p>
                <img 
                    src="placeholder.jpg" 
                    data-src="high-res-from-data.jpg"
                />
            </article>
        `;

        const result = await parseArticle(document);
        expect(result.content).toBeDefined();
        const img = result.content.find(b => b.type === 'image');
        expect(img).toBeDefined();
        expect(img.src).toContain('high-res-from-data.jpg');
    });

    test('should extract image from data-attrs JSON', async () => {
        document.body.innerHTML = `
            <article>
                <h1>Article Title</h1>
                <p>Intro paragraph.</p>
                <img 
                    src="placeholder.jpg" 
                    data-attrs='{"src":"high-res-from-json.jpg", "fullscreen":null}'
                />
            </article>
        `;

        const result = await parseArticle(document);
        expect(result.content).toBeDefined();
        const img = result.content.find(b => b.type === 'image');
        expect(img).toBeDefined();
        expect(img.src).toContain('high-res-from-json.jpg');
    });
});

