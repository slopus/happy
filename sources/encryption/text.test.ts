import { describe, it, expect } from 'vitest';
import { encodeUTF8, decodeUTF8, normalizeNFKD } from './text';

describe('Text utilities', () => {
    describe('encodeUTF8', () => {
        it('should encode ASCII string correctly', () => {
            const input = 'Hello, World!';
            const expected = new Uint8Array([72, 101, 108, 108, 111, 44, 32, 87, 111, 114, 108, 100, 33]);
            expect(encodeUTF8(input)).toEqual(expected);
        });

        it('should encode Unicode string correctly', () => {
            const input = 'Hello, 世界!';
            const expected = new Uint8Array([72, 101, 108, 108, 111, 44, 32, 228, 184, 150, 231, 149, 140, 33]);
            expect(encodeUTF8(input)).toEqual(expected);
        });
    });

    describe('decodeUTF8', () => {
        it('should decode ASCII bytes correctly', () => {
            const input = new Uint8Array([72, 101, 108, 108, 111, 44, 32, 87, 111, 114, 108, 100, 33]);
            const expected = 'Hello, World!';
            expect(decodeUTF8(input)).toBe(expected);
        });

        it('should decode Unicode bytes correctly', () => {
            const input = new Uint8Array([72, 101, 108, 108, 111, 44, 32, 228, 184, 150, 231, 149, 140, 33]);
            const expected = 'Hello, 世界!';
            expect(decodeUTF8(input)).toBe(expected);
        });
    });

    describe('normalizeNFKD', () => {
        it('should normalize ligatures', () => {
            expect(normalizeNFKD('ﬁ')).toBe('fi');
            expect(normalizeNFKD('ﬀ')).toBe('ff');
            expect(normalizeNFKD('ﬄ')).toBe('ffl');
        });

        it('should normalize accented characters', () => {
            expect(normalizeNFKD('é')).toBe('e\u0301');
            expect(normalizeNFKD('ñ')).toBe('n\u0303');
        });

        it('should normalize compatibility characters', () => {
            expect(normalizeNFKD('①')).toBe('1');
            expect(normalizeNFKD('㈱')).toBe('(株)');
        });

        it('should handle multiple normalizations in one string', () => {
            const input = 'ﬁrst ① éñd';
            const expected = 'first 1 e\u0301n\u0303d';
            expect(normalizeNFKD(input)).toBe(expected);
        });

        it('should return unchanged string when no normalization needed', () => {
            const input = 'Hello, World!';
            expect(normalizeNFKD(input)).toBe(input);
        });
    });
}); 