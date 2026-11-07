// Original, strict English grapheme-to-phoneme frontend for Kokoro ONNX.
// Pronunciations are DATA from CMUdict; see data/CMUDICT_LICENSE.
// No copied third-party phonemizer or executable WASM implementation.
import { tokenizePhonemes } from './phoneme-tokenizer.js';

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

export function phonemizeEnglish(text, dictionary) {
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
    const phonemes = output.join(' ').replace(/\s+([.,!?;:)"”—])/g, '$1')
        .replace(/(["“(])\s+/g, '$1');
    tokenizePhonemes(phonemes); // fail rather than discard unsupported symbols
    return phonemes;
}

export async function loadBundledEnglishLexicon(browserApi, fetchImpl) {
    const url = new globalThis.URL(browserApi.runtime.getURL('data/cmudict.dict'));
    if (!['chrome-extension:', 'moz-extension:'].includes(url.protocol)) {
        throw new TypeError('Only the packaged pronunciation dictionary is allowed');
    }
    const response = await fetchImpl.call(globalThis, url.href);
    if (!response?.ok || typeof response.text !== 'function') {
        throw new Error('Cannot read the packaged English dictionary');
    }
    const contents = await response.text();
    if (contents.length > 8_000_000) throw new RangeError('Pronunciation dictionary exceeds safety bound');
    return parseEnglishLexicon(contents);
}
