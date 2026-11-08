// Read the text of an ordinary Office Open XML .docx archive.
// JSZip is already packaged for EPUB; no additional libraries or permissions.
export const MAX_DOCX_ARCHIVE_BYTES = 24 * 1024 * 1024;
export const MAX_DOCX_XML_BYTES = 8 * 1024 * 1024;
const MAX_CONTENT_TYPES_BYTES = 128 * 1024;
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const DOCX_MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function escapeSpeechText(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Do not call JSZip.ZipObject.async('string') on untrusted input: a small
// compressed entry can expand to an unbounded string. Stop decompression at
// the configured byte limit instead.
async function readZipText(entry, byteLimit) {
    if (!entry || entry.dir || typeof entry.internalStream !== 'function') {
        throw new Error('DOCX is missing a required archive entry');
    }
    const bytes = await new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let finished = false;
        const stream = entry.internalStream('uint8array');
        stream.on('data', chunk => {
            if (finished) return;
            total += chunk.byteLength;
            if (total > byteLimit) {
                finished = true;
                stream.pause();
                reject(new Error('DOCX XML part exceeds its safe size limit'));
                return;
            }
            chunks.push(chunk);
        });
        stream.on('error', error => {
            if (finished) return;
            finished = true;
            reject(error);
        });
        stream.on('end', () => {
            if (finished) return;
            finished = true;
            const result = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.byteLength;
            }
            resolve(result);
        });
        stream.resume();
    });
    try {
        return new window.TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error('DOCX contains invalid UTF-8 XML');
    }
}

function parseXml(xml, expectedRoot) {
    // Inert XML parsing, no external relationship or resource resolution.
    // Reject DTDs so entity definitions cannot expand user-controlled text.
    if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
        throw new Error('DOCX XML declarations are not supported');
    }
    const parsed = new window.DOMParser().parseFromString(xml, 'application/xml');
    if (parsed.getElementsByTagName('parsererror').length ||
        parsed.documentElement?.localName !== expectedRoot) {
        throw new Error('DOCX contains malformed XML');
    }
    return parsed;
}

function paragraphType(paragraph) {
    const pPr = Array.from(paragraph.children).find(child =>
        child.namespaceURI === WORD_NS && child.localName === 'pPr');
    if (!pPr) return 'text';
    const style = Array.from(pPr.children).find(child =>
        child.namespaceURI === WORD_NS && child.localName === 'pStyle');
    const value = style?.getAttributeNS(WORD_NS, 'val') || style?.getAttribute('w:val') || '';
    const match = /^Heading([1-6])$/i.exec(value);
    if (match) return 'h' + match[1];
    const outline = Array.from(pPr.children).find(child =>
        child.namespaceURI === WORD_NS && child.localName === 'outlineLvl');
    const rawLevel = outline?.getAttributeNS(WORD_NS, 'val');
    const level = rawLevel == null || rawLevel.trim() === '' ? NaN : Number(rawLevel);
    return outline && Number.isInteger(level) && level >= 0 && level <= 5
        ? 'h' + (level + 1) : 'text';
}

// A DOCX can supply two compatible representations of the same text box:
// one inside mc:Choice and a VML mc:Fallback. Extract one branch only, both
// while collecting paragraphs and while reading inline text.
function selectedCompatibilityBranch(node) {
    const children = Array.from(node.children);
    const choices = children.filter(child =>
        child.namespaceURI === MC_NS && child.localName === 'Choice');
    const fallback = children.find(child =>
        child.namespaceURI === MC_NS && child.localName === 'Fallback');
    // We can extract Word text/paragraphs even inside a drawing wrapper.
    // Prefer a Choice containing readable Word content; otherwise use the
    // fallback. Never visit both representations.
    return choices.find(choice =>
        choice.getElementsByTagNameNS(WORD_NS, 'p').length > 0 ||
        choice.getElementsByTagNameNS(WORD_NS, 't').length > 0) ||
        fallback || choices[0] || null;
}

function collectWordParagraphs(container, collected) {
    for (const child of container.childNodes) {
        if (child.nodeType !== 1) continue;
        if (child.namespaceURI === WORD_NS &&
            (child.localName === 'del' || child.localName === 'moveFrom')) continue;
        if (child.namespaceURI === MC_NS && child.localName === 'AlternateContent') {
            const branch = selectedCompatibilityBranch(child);
            if (branch) collectWordParagraphs(branch, collected);
            continue;
        }
        if (child.namespaceURI === WORD_NS && child.localName === 'p') {
            collected.push(child);
        }
        collectWordParagraphs(child, collected);
    }
}

function paragraphText(paragraph) {
    let result = '';
    const excluded = new Set(['del', 'moveFrom', 'instrText']);
    const walk = node => {
        if (node.nodeType !== 1) return;
        if (node.namespaceURI === MC_NS && node.localName === 'AlternateContent') {
            const branch = selectedCompatibilityBranch(node);
            if (branch) walk(branch);
            return;
        }
        if (node.namespaceURI !== WORD_NS) {
            for (const child of node.childNodes) walk(child);
            return;
        }
        if (excluded.has(node.localName)) return;
        // Word text boxes embed complete w:p paragraphs inside a normal
        // w:p. Those paragraphs are emitted separately by the filtered collector;
        // including them in their outer paragraph repeats the spoken text.
        if (node.localName === 'p' && node !== paragraph) return;
        if (node.localName === 't') {
            result += node.textContent || '';
            return;
        }
        if (node.localName === 'tab') {
            result += ' ';
            return;
        }
        if (node.localName === 'br' || node.localName === 'cr') {
            result += '\n';
            return;
        }
        if (node.localName === 'noBreakHyphen') {
            result += '-';
            return;
        }
        for (const child of node.childNodes) walk(child);
    };
    for (const child of paragraph.childNodes) walk(child);
    return result.replace(/\s+/g, ' ').trim();
}

export async function parseDocxDocument(buffer, jszip = window.JSZip) {
    if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]') {
        throw new Error('DOCX contains no readable binary data');
    }
    if (buffer.byteLength > MAX_DOCX_ARCHIVE_BYTES) {
        throw new Error('DOCX files larger than 24 MiB are not supported');
    }
    if (!jszip || typeof jszip.loadAsync !== 'function') {
        throw new Error('Packaged DOCX archive reader is unavailable');
    }

    let archive;
    try {
        archive = await jszip.loadAsync(buffer);
    } catch {
        throw new Error('Unable to open DOCX: archive is corrupt, encrypted, or not a ZIP');
    }

    const main = archive.file('word/document.xml');
    const contentTypes = archive.file('[Content_Types].xml');
    if (!main || !contentTypes) {
        throw new Error('Not a valid Word DOCX archive (missing document.xml or content types)');
    }
    const typesXml = await readZipText(contentTypes, MAX_CONTENT_TYPES_BYTES);
    if (!typesXml.includes(DOCX_MAIN_TYPE)) {
        throw new Error('Not a supported Word DOCX document');
    }
    const xml = await readZipText(main, MAX_DOCX_XML_BYTES);
    const documentXml = parseXml(xml, 'document');
    if (documentXml.documentElement.namespaceURI !== WORD_NS) {
        throw new Error('DOCX document has an unexpected XML namespace');
    }
    const body = documentXml.getElementsByTagNameNS(WORD_NS, 'body')[0];
    if (!body) throw new Error('DOCX is missing its document body');

    const blocks = [];
    // Recursively select *one* compatibility branch and prune deleted/moved
    // source paragraphs. A document-wide getElementsByTagNameNS would include
    // both mc:Choice and mc:Fallback, duplicating spoken text-box content.
    // Preserve document order, including table and chosen text-box paragraphs.
    const paragraphs = [];
    collectWordParagraphs(body, paragraphs);
    for (const paragraph of paragraphs) {
        const text = paragraphText(paragraph);
        if (!text) continue;
        blocks.push({
            type: paragraphType(paragraph),
            content: text,
            html: escapeSpeechText(text),
            ids: [],
        });
    }
    if (!blocks.length) throw new Error('DOCX contains no readable paragraphs');
    return blocks;
}
