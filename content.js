browser.runtime.onMessage.addListener((request, sender) => {
    if (request.action === "PARSE_ARTICLE") {
        return new Promise((resolve) => {
            try {
                const documentClone = document.cloneNode(true);
                const classesToPreserve = [
                    'caption', 'wp-caption-text', 'image-caption', 'figure-caption', 'figcaption-text', 'credit',
                    'newsletter', 'promo', 'subscribe', 'subscription', 'cta', 'advertisement'
                ];
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
                                if (!target && CSS && CSS.escape) {
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
                    const captionSelector = 'figcaption, .caption, .wp-caption-text, .image-caption, .figure-caption, .figcaption-text, .credit';
                    const promoSelector = '.newsletter, .promo, .subscribe, .subscription, .cta, .advertisement';
                    const promoRegex = /(?:subscribe|sign up|join).{0,60}(?:newsletter|mailing list|community|updates?)|(?:support|donate).{0,60}(?:us|our work|patreon)|(?:follow|connect with).{0,60}(?:us|on social)/i;
                    const nodes = articleDoc.body.querySelectorAll(`p, h1, h2, h3, h4, h5, h6, li, img, table, figure, ${captionSelector}, ${promoSelector}`);

                    function getSanitizedHtml(node) {
                        const clone = node.cloneNode(true);
                        // Clean up links in the clone
                        const links = clone.querySelectorAll('a');
                        links.forEach(a => {
                            try {
                                const href = a.getAttribute('href');
                                if (href) {
                                    a.href = new URL(href, window.location.href).href;
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

                        if (node.tagName === 'IMG') {
                            const src = node.getAttribute('src');
                            if (src) {
                                try {
                                    const absSrc = new URL(src, window.location.href).href;
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
                                        a.href = new URL(href, window.location.href).href;
                                        a.target = '_blank';
                                        a.rel = 'noopener noreferrer';
                                    }
                                } catch (e) { }
                            });
                            blocks.push({ type: 'html', content: "Table", html: clone.outerHTML });
                        } else if (node.tagName === 'FIGURE') {
                            const clone = node.cloneNode(true);
                            const links = clone.querySelectorAll('a');
                            links.forEach(a => {
                                try {
                                    const href = a.getAttribute('href');
                                    if (href) {
                                        a.href = new URL(href, window.location.href).href;
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
                                    blocks.push({ type: 'text', content: text, html: html });
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
    }
});

window.addEventListener('message', (event) => {
    if (event.data === 'CLOSE_KOKORO_PLAYER') {
        const container = document.getElementById('kokoro-overlay-container');
        if (container) {
            container.remove();
            document.body.style.overflow = '';
        }
    }
});
