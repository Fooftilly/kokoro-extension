// #61 / KE-32 — dictionary-safe longer shared English paragraph for dual local
// comparison. Keep common CMUdict words only; digits/emoji/OOV fail closed on ONNX.
const LONGER_SHARED_ENGLISH_SAMPLE =
    'Hello friends. Please measure this longer English paragraph carefully ' +
    'so both local systems share one sample.';

const LONGER_SHARED_ENGLISH_BUTTON_ID = 'useLongerEnglishSample';

function assertLongerSharedEnglishSample(text) {
    if (String(text || '').trim() !== LONGER_SHARED_ENGLISH_SAMPLE) {
        throw Error('Expected longer shared English sample, got: ' +
            JSON.stringify(text));
    }
    return true;
}

const api = {
    LONGER_SHARED_ENGLISH_SAMPLE,
    LONGER_SHARED_ENGLISH_BUTTON_ID,
    assertLongerSharedEnglishSample,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof window !== 'undefined') {
    window.KokoroLongerSharedEnglish = api;
}

export {
    LONGER_SHARED_ENGLISH_SAMPLE,
    LONGER_SHARED_ENGLISH_BUTTON_ID,
    assertLongerSharedEnglishSample,
};
