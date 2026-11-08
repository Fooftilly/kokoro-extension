// Plain-document parsing for the reader. This module never executes file HTML,
// loads external resources or creates unsanitized markup for the speech player.
export const MAX_TEXT_DOCUMENT_BYTES = 4 * 1024 * 1024;

const extensions = new Map([
    ['epub', 'epub'],
    ['txt', 'text'],
    ['text', 'text'],
    ['md', 'markdown'],
    ['markdown', 'markdown'],
    ['html', 'html'],
    ['htm', 'html'],
    ['xhtml', 'html'],
]);

export function detectDocumentFormat(file) {
    const extension = String(file?.name || '').toLowerCase().match(/\.([^.]+)$/)?.[1];
    if (extensions.has(extension)) return extensions.get(extension);
    const mime = String(file?.type || '').toLowerCase().split(';')[0].trim();
    if (mime === 'application/epub+zip') return 'epub';
    if (mime === 'text/plain') return 'text';
    if (mime === 'text/markdown') return 'markdown';
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
    throw new Error('Unsupported format. Choose EPUB, TXT, Markdown, or HTML.');
}

export function decodeTextDocument(buffer) {
    // FileReader buffers can cross extension/iframe realms; instanceof
    // ArrayBuffer compares constructors and rejects otherwise valid bytes.
    if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]') {
        throw new Error('The selected document has no readable binary data');
    }
    if (buffer.byteLength > MAX_TEXT_DOCUMENT_BYTES) {
        throw new Error('Text documents larger than 4 MiB are not supported');
    }
    const bytes = new Uint8Array(buffer);
    let encoding = 'utf-8';
    let offset = 0;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        offset = 3;
    } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        encoding = 'utf-16le';
        offset = 2;
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        encoding = 'utf-16be';
        offset = 2;
    }

    let text;
    try {
        text = new window.TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
    } catch {
        throw new Error('Cannot decode document: use UTF-8 or BOM-marked UTF-16 text');
    }
    // Strict UTF-8 does not by itself reject binary files composed of ASCII
    // bytes. Control/null characters are a strong indicator of non-text input.
    for (const character of text) {
        const code = character.charCodeAt(0);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
            throw new Error('Document contains binary or unsupported control characters');
        }
    }
    if (!text.trim()) throw new Error('The document contains no readable text');
    return text;
}

function escaped(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function block(type, text) {
    const content = text.replace(/\s+/g, ' ').trim();
    return content ? { type, content, html: escaped(content), ids: [] } : null;
}

function plainTextBlocks(text) {
    return text.replace(/\r\n?/g, '\n').split(/\n\s*\n+/)
        .map(paragraph => block('text', paragraph))
        .filter(Boolean);
}

function markdownBlocks(text) {
    const blocks = [];
    let paragraph = [];
    let fenced = false;
    const flush = () => {
        if (!paragraph.length) return;
        const entry = block('text', paragraph.join(' '));
        if (entry) blocks.push(entry);
        paragraph = [];
    };
    // Keep the text of code fences as text; never execute Markdown HTML.
    for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
        const line = rawLine.trim();
        if (/^(`{3,}|~{3,})/.test(line)) {
            flush();
            fenced = !fenced;
            continue;
        }
        if (!line) {
            flush();
            continue;
        }
        if (fenced) {
            paragraph.push(line);
            continue;
        }
        const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading) {
            flush();
            const entry = block('h' + heading[1].length, cleanMarkdownInline(heading[2]));
            if (entry) blocks.push(entry);
            continue;
        }
        paragraph.push(cleanMarkdownInline(line
            .replace(/^\s*>\s?/, '')
            .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')));
    }
    flush();
    return blocks;
}

function cleanMarkdownInline(text) {
    return text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|~~|`)/g, '')
        .replace(/(?<!\w)[*_](?=\w)|(?<=\w)[*_](?!\w)/g, '');
}

function htmlBlocks(text) {
    // DOMParser.parseFromString('text/html') may fetch iframe/image resources
    // despite script execution being disabled. A detached template parses HTML
    // into inert content that cannot initiate embedded resource downloads.
    const template = document.createElement('template');
    template.innerHTML = text;
    const results = [];
    const ignored = new Set([
        'script', 'style', 'noscript', 'template', 'svg', 'iframe',
        'object', 'embed', 'head', 'canvas', 'link', 'meta',
    ]);
    const meaningful = new Set(['p', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    const boundaries = new Set([
        'p', 'div', 'section', 'article', 'blockquote', 'li', 'pre',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td',
    ]);

    // Never use raw textContent on a recognized paragraph: its descendants
    // can contain scripts/styles, and <br>/nested paragraphs need separators.
    function safeText(node) {
        if (node.nodeType === 3) return node.textContent || '';
        if (node.nodeType !== 1) return '';
        const name = node.tagName.toLowerCase();
        if (ignored.has(name) || name === 'br' || name === 'hr') return ' ';
        const content = Array.from(node.childNodes, safeText).join('');
        return boundaries.has(name) ? ' ' + content + ' ' : content;
    }

    function visit(node) {
        if (node.nodeType === 3) {
            const entry = block('text', node.textContent || '');
            if (entry) results.push(entry);
            return;
        }
        if (node.nodeType !== 1) return;
        const name = node.tagName.toLowerCase();
        if (ignored.has(name)) return;
        if (meaningful.has(name)) {
            const entry = block(/^h[1-6]$/.test(name) ? name : 'text', safeText(node));
            if (entry) results.push(entry);
            return;
        }
        for (const child of node.childNodes) visit(child);
    }
    for (const child of template.content.childNodes) visit(child);
    return results;
}

export function parseTextDocument(format, text) {
    let blocks;
    if (format === 'text') blocks = plainTextBlocks(text);
    else if (format === 'markdown') blocks = markdownBlocks(text);
    else if (format === 'html') blocks = htmlBlocks(text);
    else throw new Error('Unsupported text document format');
    if (!blocks.length) throw new Error('The document contains no readable paragraphs');
    return blocks;
}
