import { describe, it, expect } from 'vitest';
import { separateName } from './separateName';

describe('separateName', () => {
    it('should separate basic first and last name', () => {
        const result = separateName('John Doe');
        expect(result).toEqual({ firstName: 'John', lastName: 'Doe' });
    });

    it('should handle single name with no last name', () => {
        const result = separateName('John');
        expect(result).toEqual({ firstName: 'John', lastName: null });
    });

    it('should handle multiple names putting everything after first as lastName', () => {
        const result = separateName('John William Doe Smith');
        expect(result).toEqual({ firstName: 'John', lastName: 'William Doe Smith' });
    });

    it('should handle empty string', () => {
        const result = separateName('');
        expect(result).toEqual({ firstName: null, lastName: null });
    });

    it('should handle null input', () => {
        const result = separateName(null);
        expect(result).toEqual({ firstName: null, lastName: null });
    });

    it('should handle undefined input', () => {
        const result = separateName(undefined);
        expect(result).toEqual({ firstName: null, lastName: null });
    });

    it('should handle whitespace-only string', () => {
        const result = separateName('   ');
        expect(result).toEqual({ firstName: null, lastName: null });
    });

    it('should handle extra spaces between names', () => {
        const result = separateName('  John    Doe  ');
        expect(result).toEqual({ firstName: 'John', lastName: 'Doe' });
    });

    it('should handle names with special characters', () => {
        const result = separateName('José María');
        expect(result).toEqual({ firstName: 'José', lastName: 'María' });
    });

    it('should handle hyphenated last names', () => {
        const result = separateName('Mary Smith-Johnson');
        expect(result).toEqual({ firstName: 'Mary', lastName: 'Smith-Johnson' });
    });

    it('should handle multiple middle names and hyphenated last name', () => {
        const result = separateName('John Michael Robert Smith-Johnson');
        expect(result).toEqual({ firstName: 'John', lastName: 'Michael Robert Smith-Johnson' });
    });
});