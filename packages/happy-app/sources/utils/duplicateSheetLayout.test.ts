import { describe, expect, it } from 'vitest';
import { getDuplicateSheetFrame } from './duplicateSheetLayout';

describe('getDuplicateSheetFrame', () => {
    it('keeps the duplicate sheet inside a narrow phone viewport', () => {
        expect(getDuplicateSheetFrame({ width: 240, height: 516 })).toEqual({
            width: 208,
            maxHeight: 439,
        });
    });

    it('caps the duplicate sheet width on larger screens', () => {
        expect(getDuplicateSheetFrame({ width: 1200, height: 900 })).toEqual({
            width: 560,
            maxHeight: 765,
        });
    });
});
