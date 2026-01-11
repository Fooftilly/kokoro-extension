// Extract logic for testing
function parseArticle(doc, win = window) {
    return new Promise((resolve) => {
        try {
            const documentClone = doc.cloneNode(true);
            const classesToPreserve = [
                'caption', 'wp-caption-text', 'image-caption', 'figure-caption', 'figcaption-text', 'credit', 'legacy-caption',
                'newsletter', 'promo', 'subscribe', 'subscription', 'cta', 'advertisement'
            ];
            // Readability is assumed to be available globally
            const article = new Readability(documentClone, { classesToPreserve }).parse();
            if (article && article.textContent) {
                // Clean up whitespace a bit
                const docParser = new DOMParser();
                const articleDoc = docParser.parseFromString(article.content, 'text/html');

                // Process footnotes (convert numeric internal links to tooltips)
                try {
                    const footnoteCache = new Map();
                    const allLinks = articleDoc.querySelectorAll('a');
                    allLinks.forEach(link => {
                        const text = link.textContent.trim();
                        if (!/^\[?\(?\d+\)?\]?$/.test(text)) return;
                        const href = link.getAttribute('href');
                        if (!href) return;
                        const hashIndex = href.indexOf('#');
                        if (hashIndex === -1 || hashIndex === href.length - 1) return;
                        const id = href.substring(hashIndex + 1);
                        let noteText = null;
                        if (footnoteCache.has(id)) {
                            noteText = footnoteCache.get(id);
                        } else {
                            let target = articleDoc.getElementById(id);
                            if (!target && typeof CSS !== 'undefined' && CSS.escape) {
                                try {
                                    target = articleDoc.querySelector(`#${CSS.escape(id)}`) || articleDoc.querySelector(`[name="${CSS.escape(id)}"]`);
                                } catch (e) { }
                            }
                            if (target) {
                                let contentEl = target;
                                if ((target.tagName === 'A' || target.tagName === 'SPAN') && target.closest('li')) {
                                    contentEl = target.closest('li');
                                }
                                noteText = contentEl.textContent.trim();
                                noteText = noteText.replace(/[↩↑^]/g, '').replace(/^\d+\.?\s*/, '').trim();
                                footnoteCache.set(id, noteText);
                                contentEl.remove();
                            }
                        }
                        if (noteText && noteText.length > 0) {
                            const span = articleDoc.createElement('span');
                            span.className = 'footnote-ref';
                            span.textContent = '';
                            span.setAttribute('data-ref', text);
                            span.title = noteText;
                            span.setAttribute('data-content', noteText);
                            link.replaceWith(span);
                        }
                    });
                } catch (e) {
                    console.warn("Footnote processing error", e);
                }

                // Extract paragraphs, headers, and images
                const blocks = [];
                const captionSelector = 'figcaption, .caption, .wp-caption-text, .image-caption, .figure-caption, .figcaption-text, .credit, .legacy-caption';
                const promoSelector = '.newsletter, .promo, .subscribe, .subscription, .cta, .advertisement';
                const promoRegex = /(?:subscribe|sign up|join).{0,60}(?:newsletter|mailing list|community|updates?)|(?:support|donate).{0,60}(?:us|our work|patreon)|(?:follow|connect with).{0,60}(?:us|on social)/i;
                const nodes = articleDoc.body.querySelectorAll(`p, h1, h2, h3, h4, h5, h6, li, img, table, figure, pre, ${captionSelector}, ${promoSelector}`);

                function getSanitizedHtml(node) {
                    const clone = node.cloneNode(true);
                    // Clean up links in the clone
                    const links = clone.querySelectorAll('a');
                    links.forEach(a => {
                        try {
                            const href = a.getAttribute('href');
                            if (href) {
                                a.href = new URL(href, win.location.href).href;
                                a.target = '_blank';
                                a.rel = 'noopener noreferrer';
                            }
                        } catch (e) { }
                    });
                    return clone.innerHTML.trim();
                }

                nodes.forEach(node => {
                    // Avoid duplicating content inside tables or figures if we are processing the container
                    const closestTable = node.closest('table');
                    if (closestTable && closestTable !== node) return;

                    const closestFigure = node.closest('figure');
                    if (closestFigure && closestFigure !== node) return;

                    const closestCaption = node.closest(captionSelector);
                    if (closestCaption && closestCaption !== node) return;

                    const closestLI = node.closest('li');
                    if (closestLI && closestLI !== node) return;

                    if (node.tagName === 'IMG') {
                        let src = null;

                        // 1. Try srcset for potentially higher resolution
                        const srcset = node.getAttribute('srcset');
                        if (srcset) {
                            const parts = srcset.split(',').map(p => p.trim().split(/\s+/));
                            if (parts.length > 0) {
                                // Take the last one which is usually the highest resolution
                                src = parts[parts.length - 1][0];
                            }
                        }

                        // 2. Try Substack-specific data-attrs
                        if (!src) {
                            const dataAttrs = node.getAttribute('data-attrs');
                            if (dataAttrs) {
                                try {
                                    const attrs = JSON.parse(dataAttrs);
                                    if (attrs.src) src = attrs.src;
                                } catch (e) { }
                            }
                        }

                        // 3. Try data-src / data-actual-src
                        if (!src || src.startsWith('data:image')) {
                            src = node.getAttribute('data-src') || node.getAttribute('data-actual-src');
                        }

                        // 4. Fallback to src
                        if (!src || src.startsWith('data:image')) {
                            src = node.getAttribute('src');
                        }

                        if (src) {
                            try {
                                const absSrc = new URL(src, win.location.href).href;
                                blocks.push({ type: 'image', src: absSrc });
                            } catch (e) { }
                        }
                    } else if (node.tagName === 'TABLE') {
                        const html = getSanitizedHtml(node); // Full outer HTML would be better? getSanitizedHtml uses innerHTML.
                        // We want the whole table tag.
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = node.outerHTML; // Use outerHTML to keep <table>
                        // Sanitize inside? getSanitizedHtml logic is: clone -> fix links -> return innerHTML.
                        // If we pass `node` (the table) to getSanitizedHtml, it returns content INSIDE table.
                        // We want the table itself.
                        // Let's adjust getSanitizedHtml to support returning outer if needed, or just do it here.
                        const clone = node.cloneNode(true);
                        const links = clone.querySelectorAll('a');
                        links.forEach(a => {
                            try {
                                const href = a.getAttribute('href');
                                if (href) {
                                    a.href = new URL(href, win.location.href).href;
                                    a.target = '_blank';
                                    a.rel = 'noopener noreferrer';
                                }
                            } catch (e) { }
                        });
                        blocks.push({ type: 'html', content: "Table", html: clone.outerHTML });
                    } else if (node.tagName === 'LI') {
                        const html = getSanitizedHtml(node);
                        // Calculate depth
                        let depth = 0;
                        let parent = node.parentElement;
                        let listType = 'ul';
                        while (parent) {
                            if (parent.tagName === 'UL' || parent.tagName === 'OL') {
                                if (depth === 0) listType = parent.tagName.toLowerCase();
                                depth++;
                            }
                            parent = parent.parentElement;
                            // Safety break
                            if (depth > 10) break;
                        }
                        // Adjust depth to be 0-indexed relative to top-level list
                        const safeDepth = Math.max(0, depth - 1);

                        const text = node.textContent.replace(/\s+/g, ' ').trim();
                        if (text.length > 0) {
                            blocks.push({
                                type: 'list-item',
                                content: text,
                                html: html,
                                depth: safeDepth,
                                listType: listType,
                                isQuote: !!node.closest('blockquote')
                            });
                        }
                    } else if (node.tagName === 'PRE') {
                        // Extract code blocks
                        const codeNode = node.querySelector('code') || node;
                        const text = codeNode.textContent;
                        if (text.trim().length > 0) {
                            blocks.push({
                                type: 'code',
                                content: text,
                                html: getSanitizedHtml(node)
                            });
                        }
                    } else if (node.tagName === 'FIGURE') {
                        const clone = node.cloneNode(true);
                        const links = clone.querySelectorAll('a');
                        links.forEach(a => {
                            try {
                                const href = a.getAttribute('href');
                                if (href) {
                                    a.href = new URL(href, win.location.href).href;
                                    a.target = '_blank';
                                    a.rel = 'noopener noreferrer';
                                }
                            } catch (e) { }
                        });
                        // Figures often contain images. We can render the whole figure as an HTML block.
                        blocks.push({ type: 'html', content: "Figure", html: clone.outerHTML });
                    } else if (node.matches(captionSelector)) {
                        const text = node.textContent.replace(/\s+/g, ' ').trim();
                        if (text.length > 0) blocks.push({ type: 'caption', content: text });
                    } else {
                        const text = node.textContent.replace(/\s+/g, ' ').trim();
                        if (text.length > 0) {
                            const isPromoClass = node.matches(promoSelector);
                            const isPromoText = text.length < 300 && promoRegex.test(text);
                            if (isPromoClass || isPromoText) {
                                blocks.push({ type: 'silent', content: text });
                            } else {
                                const html = getSanitizedHtml(node);
                                let type = 'text';
                                if (/^H[1-6]$/.test(node.tagName)) {
                                    type = node.tagName.toLowerCase();
                                }
                                blocks.push({
                                    type: type,
                                    content: text,
                                    html: html,
                                    isQuote: !!node.closest('blockquote')
                                });
                            }
                        }
                    }
                });

                const cleanText = blocks.filter(b => b.type === 'text').map(b => b.content).join('\n\n');
                resolve({ text: cleanText, content: blocks });
            } else {
                resolve({ text: null });
            }
        } catch (e) {
            console.error("Kokoro Readability Error:", e);
            resolve({ text: null });
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseArticle };
}

browser.runtime.onMessage.addListener((request, sender) => {
    if (request.action === "PARSE_ARTICLE") {
        return parseArticle(document);
    }

    if (request.action === "SHOW_PLAYER") {
        if (document.getElementById('kokoro-overlay-container')) {
            return;
        }

        const container = document.createElement('div');
        container.id = 'kokoro-overlay-container';
        container.style.position = 'fixed';
        container.style.zIndex = '2147483647';
        container.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        container.style.borderRadius = '12px';
        container.style.overflow = 'hidden';
        container.style.border = 'none';

        if (request.mode === 'full') {
            container.style.top = '0';
            container.style.left = '0';
            container.style.width = '100vw';
            container.style.height = '100vh';
            container.style.borderRadius = '0';
            container.style.background = 'rgba(0, 0, 0, 0.5)';
            container.style.display = 'flex';
            container.style.justifyContent = 'center';
            container.style.alignItems = 'center';
        } else {
            container.style.top = '20px';
            container.style.right = '20px';
            container.style.width = '320px';
            container.style.height = '500px';
        }

        const iframe = document.createElement('iframe');
        iframe.src = browser.runtime.getURL('overlay.html');
        iframe.style.border = 'none';
        iframe.allow = "autoplay";
        iframe.tabIndex = "-1"; // Make programmatically focusable

        iframe.addEventListener('load', () => {
            iframe.focus();
        });

        if (request.mode === 'full') {
            iframe.style.width = '80%';
            iframe.style.maxWidth = '900px';
            iframe.style.height = '90%';
            iframe.style.maxHeight = '90vh';
            iframe.style.borderRadius = '12px';
            iframe.style.boxShadow = '0 10px 30px rgba(0,0,0,0.3)';
            iframe.style.background = 'white';
        } else {
            iframe.style.width = '100%';
            iframe.style.height = '100%';
        }

        container.appendChild(iframe);
        document.body.appendChild(container);

        if (request.mode === 'full') {
            document.body.style.overflow = 'hidden';
        }
    } else if (request.action === "REMOVE_PLAYER") {
        const container = document.getElementById('kokoro-overlay-container');
        if (container) {
            container.remove();
            document.body.style.overflow = '';
        }
    } else if (request.action === "NAV_NEXT" || request.action === "NAV_PREV") {
        const container = document.getElementById('kokoro-overlay-container');
        if (container) {
            const iframe = container.querySelector('iframe');
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage(request.action, '*');
            }
        }
    }
});

window.addEventListener('message', (event) => {
    if (event.data === 'CLOSE_KOKORO_PLAYER') {
        const container = document.getElementById('kokoro-overlay-container');
        if (container) {
            container.remove();
            document.body.style.overflow = '';
        }
    } else if (event.data && event.data.action === 'KOKORO_SCROLL_TO_BLOCK') {
        const searchText = event.data.text;
        if (!searchText) return;

        // Try to find the element on the page that contains this text
        // We look for the smallest element that contains the text
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        let bestMatch = null;

        while (node = walker.nextNode()) {
            if (node.textContent.includes(searchText)) {
                const parent = node.parentElement;
                // Avoid scrolling to our own overlay
                if (parent.closest('#kokoro-overlay-container')) continue;

                // We want the most specific element (e.g. the P or LI, not the BODY)
                if (!bestMatch || bestMatch.contains(parent)) {
                    bestMatch = parent;
                }
            }
        }

        if (bestMatch) {
            // Refined scrolling logic: only scroll if the element is not comfortably in view
            const rect = bestMatch.getBoundingClientRect();
            const viewportHeight = window.innerHeight;

            // Define a "comfort zone" (middle 40% of the screen)
            // If the element is within 30% to 70% of the viewport height, we don't scroll
            const topThreshold = viewportHeight * 0.3;
            const bottomThreshold = viewportHeight * 0.7;

            const isAboveZone = rect.top < topThreshold;
            const isBelowZone = rect.bottom > bottomThreshold;

            if (isAboveZone || isBelowZone) {
                bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }
});
