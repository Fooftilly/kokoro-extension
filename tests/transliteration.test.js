
describe('transliteration-lite', () => {
    beforeAll(() => {
        // Load the script. Since it's an IIFE that sets window.transliterate, 
        // we can just require it if we were in a browser, but in Jest,
        // we can just copy-paste or read and eval.
        // Simplified: just redefine it here for the test or use the actual file.
        const fs = require('fs');
        const path = require('path');
        const code = fs.readFileSync(path.resolve(__dirname, '../transliteration-lite.js'), 'utf8');
        eval(code);
    });

    test('Transliterates Serbian Cyrillic to Latin', () => {
        const input = 'Никола Тесла';
        const expected = 'Nikola Tesla';
        expect(window.transliterate(input)).toBe(expected);
    });

    test('Handles Serbian specific characters', () => {
        const input = 'Ђурђевак, Љубичица, Његош, Џип, Ћирилица, Чаша, Шатор, Живот';
        const expected = 'Đurđevak, Ljubičica, Njegoš, Džip, Ćirilica, Čaša, Šator, Život';
        expect(window.transliterate(input)).toBe(expected);
    });

    test('Handles lowercase Serbian specific characters', () => {
        const input = 'ђурђевак, љубичица, његош, џип, ћирилица, чаша, шатор, живот';
        const expected = 'đurđevak, ljubičica, njegoš, džip, ćirilica, čaša, šator, život';
        expect(window.transliterate(input)).toBe(expected);
    });

    test('Preserves non-Cyrillic/Greek characters', () => {
        const input = 'Hello World! 123 @#$';
        expect(window.transliterate(input)).toBe(input);
    });

    test('Transliterates Greek to Latin', () => {
        const input = 'Βουκελλάριοι';
        // 'B' or 'V' depending on mapping. I used 'V' for Β and 'b' for β in implementation.
        // Wait, let me check my mapping again. 
        // 'Β': 'V', 'α': 'a', 'β': 'v'... 
        // Β -> V, ο -> o, υ -> y, κ -> k, ε -> e, λ -> l, ά -> a, ρ -> r, ι -> i, ο -> o, ι -> i
        expect(window.transliterate(input)).toBe('Voykellarioi');
    });

    test('Handles accented Greek characters', () => {
        const input = 'άέήίόύώϊϋΐΰ';
        const expected = 'aeiioyoiyiy'; // Based on my mapping: ά->a, έ->e, ή->i, ί->i, ό->o, ύ->y, ώ->o, ϊ->i, ϋ->y, ΐ->i, ΰ->y
        expect(window.transliterate(input)).toBe(expected);
    });

    test('Transliterates Russian Cyrillic', () => {
        const input = 'Эй, жлоб! Где туз? Прячь юных съёмщиц в шкаф.';
        // This is a common Russian pangram.
        // I need to check my mapping for Russian specific chars.
        // Э -> E, й -> y, ж -> ž, л -> l, о -> o, б -> b
        // г -> g, д -> d, е -> e
        // т -> t, у -> u, з -> z
        // П -> P, р -> r, я -> ya, ч -> č
        // ю -> yu, н -> n, ы -> y, х -> h
        // с -> s, ъ -> '', ё -> yo, м -> m, щ -> shch, и -> i, ц -> c
        // в -> v
        // ш -> š, к -> k, а -> a, ф -> f
        // Note: Serbian 'ж' is 'ж' too, mapped to 'ž'.
        const result = window.transliterate(input);
        expect(result).toContain('Ey, žlob!');
        expect(result).toContain('Gde tuz?');
        expect(result).toContain('Pryač yunyh syomshchic v škaf.');
    });


    test('Handles empty and null input', () => {
        expect(window.transliterate('')).toBe('');
        expect(window.transliterate(null)).toBe(null);
    });
});
