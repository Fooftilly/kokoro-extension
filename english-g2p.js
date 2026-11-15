// Original, strict English grapheme-to-phoneme frontend for Kokoro ONNX.
// Pronunciations are separately downloaded CMUdict data; see data/CMUDICT_LICENSE.
// No copied third-party phonemizer or executable WASM implementation.
import { tokenizePhonemes, MAX_PHONEMES } from './phoneme-tokenizer.js';
import { dictionaryManifest } from './model-catalog.js';
import { ModelDataStore } from './model-data-store.js';

const PHONES = Object.freeze({
    AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ',
    B: 'b', CH: 'ʧ', D: 'd', DH: 'ð', EH: 'ɛ', ER: 'ɚ', EY: 'eɪ',
    F: 'f', G: 'ɡ', HH: 'h', IH: 'ɪ', IY: 'i', JH: 'ʤ', K: 'k',
    L: 'l', M: 'm', N: 'n', NG: 'ŋ', OW: 'oʊ', OY: 'ɔɪ',
    P: 'p', R: 'ɹ', S: 's', SH: 'ʃ', T: 't', TH: 'θ',
    UH: 'ʊ', UW: 'u', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
});
const VALID_WORD = /^[a-z]+(?:['-][a-z]+)*$/;
const TOKEN = /[a-z]+(?:['-][a-z]+)*|[.,!?;:()"“”—]/iy;

export function parseEnglishLexicon(data) {
    if (typeof data !== 'string' || !data) throw new TypeError('Pronunciation data required');
    const dictionary = new Map();
    for (const entry of data.split(/\r?\n/)) {
        if (!entry || entry.startsWith(';;;')) continue;
        const boundary = entry.search(/\s/);
        if (boundary < 1) continue;
        const word = entry.slice(0, boundary).toLowerCase();
        // Choose primary entries only; (2), (3) variants need POS context.
        if (!VALID_WORD.test(word) || dictionary.has(word)) continue;
        const phones = entry.slice(boundary).split('#', 1)[0].trim();
        if (phones) dictionary.set(word, phones);
    }
    if (dictionary.size === 0) throw new Error('Pronunciation dictionary is empty');
    return dictionary;
}

function toIpa(phones, word) {
    let result = '';
    for (const phone of phones.split(/\s+/)) {
        const parsed = /^([A-Z]+)([012]?)$/.exec(phone);
        const mapped = parsed && PHONES[parsed[1]];
        if (!mapped) throw new RangeError('Unknown CMU pronunciation for ' + word + ': ' + phone);
        const vowel = parsed[1] === 'AH' && parsed[2] === '0' ? 'ə' : mapped;
        result += (parsed[2] === '1' ? 'ˈ' : parsed[2] === '2' ? 'ˌ' : '') + vowel;
    }
    return result;
}

/** Stable disclosure: ONNX English is CMUdict-gated; broader G2P is not claimed. */
export const ONNX_ENGLISH_G2P_DISCLOSURE_NEEDLE =
    'dictionary-gated English; OOV fails closed; broader G2P not measured';

/**
 * Honest capability disclosure for ONNX English text synthesis.
 * Broader long-form G2P is explicitly not measured.
 */
export function discloseOnnxEnglishG2pLimits() {
    return {
        dictionaryGatedEnglish: true,
        broaderG2pMeasured: false,
        oovFailsClosed: true,
        disclosureNeedle: ONNX_ENGLISH_G2P_DISCLOSURE_NEEDLE,
    };
}

/**
 * List alphabetic tokens missing from the local CMUdict map (OOV).
 * Diagnostic only — continues past digits/emoji/punctuation so later OOV
 * words are still reported. Synthesis rejection stays in phonemizeEnglish.
 */
export function listUnsupportedEnglishWords(text, dictionary) {
    if (typeof text !== 'string' || !(dictionary instanceof Map)) {
        throw new TypeError('English text and a dictionary are required');
    }
    const input = text.normalize('NFC').replace(/’/g, "'");
    const unsupported = [];
    let offset = 0;
    while (offset < input.length) {
        if (/\s/u.test(input[offset])) { offset++; continue; }
        TOKEN.lastIndex = offset;
        const match = TOKEN.exec(input);
        // Sticky TOKEN only matches at offset. Skip one code unit for digits,
        // emoji, or other non-tokens so later alphabetic OOV words are listed.
        if (!match || match.index !== offset) {
            offset++;
            continue;
        }
        offset = TOKEN.lastIndex;
        const item = match[0];
        if (/^[a-z]/i.test(item) && !dictionary.get(item.toLowerCase())) {
            unsupported.push(item);
        }
    }
    return unsupported;
}

function renderEnglishPhonemes(text, dictionary) {
    if (typeof text !== 'string' || !text.trim() || text.length > 20000 ||
        !(dictionary instanceof Map)) {
        throw new TypeError('Bounded English text and a dictionary are required');
    }
    const input = text.normalize('NFC').replace(/’/g, "'");
    let offset = 0;
    const output = [];
    while (offset < input.length) {
        if (/\s/u.test(input[offset])) { offset++; continue; }
        TOKEN.lastIndex = offset;
        const match = TOKEN.exec(input);
        if (!match) throw new RangeError('Unsupported English text at offset ' + offset);
        offset = TOKEN.lastIndex;
        const item = match[0];
        if (/^[a-z]/i.test(item)) {
            const phones = dictionary.get(item.toLowerCase());
            if (!phones) {
                throw new RangeError('Missing English pronunciation for ' +
                    JSON.stringify(item) + '; no remote TTS fallback');
            }
            output.push(toIpa(phones, item));
        } else {
            output.push(item);
        }
    }
    return output.join(' ').replace(/\s+([.,!?;:)"”—])/g, '$1')
        .replace(/(["“(])\s+/g, '$1');
}

export function phonemizeEnglish(text, dictionary) {
    const phonemes = renderEnglishPhonemes(text, dictionary);
    tokenizePhonemes(phonemes); // fail rather than discard unsupported symbols
    return phonemes;
}

// Validate the whole request before model startup, then split only at the
// existing normalized word separators. Attached punctuation stays with its
// word; no partial words, missing pronunciations or unknown symbols are dropped.
export function phonemizeEnglishChunks(text, dictionary) {
    const phonemes = renderEnglishPhonemes(text, dictionary);
    const chunks = [];
    let current = '';
    let count = 0;
    for (const word of phonemes.split(' ')) {
        const wordTokens = tokenizePhonemes(word);
        const nextCount = count + (current ? 1 : 0) + wordTokens.length;
        if (nextCount > MAX_PHONEMES) {
            chunks.push(current);
            current = word;
            count = wordTokens.length;
        } else {
            current += (current ? ' ' : '') + word;
            count = nextCount;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

export async function loadCachedEnglishLexicon(browserApi, cacheStorage, fetchImpl = () => {}) {
    // Inference only reads local Cache Storage. Downloads require an explicit
    // click in the model manager; speech text never goes to GitHub.
    const manifest = dictionaryManifest();
    const store = new ModelDataStore({
        origin: browserApi.runtime.getURL('/'),
        cacheStorage, fetchImpl, responseClass: globalThis.Response, streamClass: globalThis.TransformStream,
    });
    const status = await store.status(manifest);
    if (!status.ready) {
        throw new Error('English dictionary not installed. Download it in the TTS model manager.');
    }
    const cache = await cacheStorage.open('kokoro-model-data-v1');
    const asset = manifest.assets[0];
    const response = await cache.match(store.key(manifest, asset));
    if (!store.isCurrent(response, asset)) {
        throw new Error('English pronunciation dictionary missing from local cache');
    }
    // Cache headers only prove which digest was expected when downloaded.
    // Verify the actual small dictionary bytes before using them as phonemes.
    // Clone so reading the digest does not consume the response used for parsing.
    if (!await store.cachedBytesMatch(response.clone(), asset)) {
        throw new Error('English dictionary failed SHA-256 integrity verification. ' +
            'Use Verify cached data, then Download to repair it.');
    }
    const contents = await response.text();
    if (contents.length > 8_000_000) throw new RangeError('Pronunciation dictionary exceeds safety bound');
    return parseEnglishLexicon(contents);
}
