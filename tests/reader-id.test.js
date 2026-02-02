/**
 * @jest-environment jsdom
 */

// Mock browser global
global.browser = {
    storage: {
        local: {
            remove: jest.fn().mockResolvedValue({}),
            set: jest.fn().mockResolvedValue({})
        },
        sync: {
            get: jest.fn().mockResolvedValue({ voice: 'en-US', apiUrl: 'http://localhost:8880/v1/' })
        }
    }
};

global.Node = window.Node;

function extractBlocksLogic(bodyElement) {
    const blocks = [];
    const usedIds = new Set();
    let pendingIds = [];

    function walk(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();
            if (['script', 'style', 'noscript'].includes(tagName)) return;

            if (node.id && !usedIds.has(node.id)) {
                pendingIds.push(node.id);
                usedIds.add(node.id);
            }

            if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote'].includes(tagName)) {
                const descendantWithIds = node.querySelectorAll('[id]');
                descendantWithIds.forEach(el => {
                    if (!usedIds.has(el.id)) {
                        pendingIds.push(el.id);
                        usedIds.add(el.id);
                    }
                });

                blocks.push({
                    type: (tagName === 'p' || tagName === 'li' || tagName === 'blockquote') ? 'text' : tagName,
                    ids: [...pendingIds],
                    content: node.textContent.trim()
                });
                pendingIds = [];
            } else {
                for (const child of node.childNodes) {
                    walk(child);
                }
            }
        } else if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text && node.parentElement === bodyElement) {
                blocks.push({ type: 'text', content: text, ids: [...pendingIds] });
                pendingIds = [];
            }
        }
    }
    walk(bodyElement);
    return blocks;
}

describe('ID Discovery Logic', () => {
    test('should claim parent ID and descendant IDs', () => {
        const div = document.createElement('div');
        div.id = 'chapter1';
        div.innerHTML = `
            <h1><span id="title-span">Chapter Title</span></h1>
            <p>First paragraph.</p>
        `;

        const blocks = extractBlocksLogic(div);
        expect(blocks[0].ids).toContain('chapter1');
        expect(blocks[0].ids).toContain('title-span');
        expect(blocks[1].ids).toHaveLength(0);
    });

    test('should collect multi-floating anchors', () => {
        const div = document.createElement('div');
        div.innerHTML = `
            <a id="id1"></a>
            <a id="id2"></a>
            <p>Text</p>
        `;

        const blocks = extractBlocksLogic(div);
        expect(blocks[0].ids).toContain('id1');
        expect(blocks[0].ids).toContain('id2');
    });

    test('should handle Word-style _Toc IDs inside headings', () => {
        const div = document.createElement('div');
        div.innerHTML = `
            <p>
                <a id="_Toc319072903"></a>
                Heading Text
            </p>
        `;

        const blocks = extractBlocksLogic(div);
        expect(blocks[0].ids).toContain('_Toc319072903');
    });
});
