import { describe, expect, it } from 'vitest';
import { splitForReadAloud } from './messageUtils';

describe('splitForReadAloud', () => {
    it('keeps short text as one chunk', () => {
        expect(splitForReadAloud('Hallo Welt. Wie geht es?')).toEqual(['Hallo Welt. Wie geht es?']);
    });

    it('packs whole sentences up to the limit', () => {
        expect(splitForReadAloud('Eins zwei. Drei vier. Fuenf sechs.', 22)).toEqual(['Eins zwei. Drei vier.', 'Fuenf sechs.']);
    });

    it('does not split inside numbers', () => {
        expect(splitForReadAloud('Pi ist 3.14 gross. Ende.', 20)).toEqual(['Pi ist 3.14 gross.', 'Ende.']);
    });

    it('splits an overlong sentence between words', () => {
        const chunks = splitForReadAloud('aaa bbb ccc ddd eee', 8);
        expect(chunks).toEqual(['aaa bbb', 'ccc ddd', 'eee']);
    });

    it('returns nothing for empty text', () => {
        expect(splitForReadAloud('   ')).toEqual([]);
    });
});
