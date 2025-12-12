/**
 * @jest-environment jsdom
 */

import { findRange } from '../dom-utils.js';

describe('findRange', () => {
    let div;

    beforeEach(() => {
        div = document.createElement('div');
    });

    test('should find range in a single text node', () => {
        div.textContent = 'Hello World';
        const range = findRange(div, 0, 5);
        expect(range).not.toBeNull();
        expect(range.toString()).toBe('Hello');
    });

    test('should find range spanning multiple text nodes', () => {
        div.innerHTML = '<span>Hello</span> <b>World</b>';
        // HTML: Hello World
        // Indices: 01234567890
        // 'Hello' (5) + ' ' (1) + 'World' (5) = 11 chars
        const range = findRange(div, 0, 11);
        expect(range).not.toBeNull();
        expect(range.toString()).toBe('Hello World');
    });

    test('should find range inside nested nodes', () => {
        div.innerHTML = '<p>Start <span>Middle</span> End</p>';
        // "Start " (6) + "Middle" (6) + " End" (4) = 16
        // "Start Middle End"
        // Target: "Middle" -> index 6 to 12
        const range = findRange(div, 6, 12);
        expect(range).not.toBeNull();
        expect(range.toString()).toBe('Middle');
    });

    test('should return null for out of bounds', () => {
        div.textContent = 'Short';
        const range = findRange(div, 10, 15);
        expect(range).toBeNull();
    });

    test('should handle end index equal to length', () => {
        div.textContent = 'Test';
        const range = findRange(div, 0, 4);
        expect(range).not.toBeNull();
        expect(range.toString()).toBe('Test');
    });
});
