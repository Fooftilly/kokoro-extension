
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

    test('Preserves non-Cyrillic characters', () => {
        const input = 'Hello World! 123 @#$';
        expect(window.transliterate(input)).toBe(input);
    });

    test('Handles empty and null input', () => {
        expect(window.transliterate('')).toBe('');
        expect(window.transliterate(null)).toBe(null);
    });
});
