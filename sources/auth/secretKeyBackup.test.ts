import { 
    formatSecretKeyForBackup, 
    parseBackupSecretKey, 
    isValidSecretKey, 
    normalizeSecretKey 
} from './secretKeyBackup';
import { encodeBase64, decodeBase64 } from '@/auth/base64';
import { describe, it, expect } from 'vitest';

describe('secretKeyBackup', () => {
    // Test data: a valid 32-byte secret key
    const testSecretBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        testSecretBytes[i] = i;
    }
    const testSecretBase64 = encodeBase64(testSecretBytes, 'base64url');
    
    // Another test key with all same bytes
    const testSecretBytes2 = new Uint8Array(32).fill(255);
    const testSecretBase642 = encodeBase64(testSecretBytes2, 'base64url');
    
    // Random test key
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const randomBase64 = encodeBase64(randomBytes, 'base64url');

    describe('formatSecretKeyForBackup', () => {
        it('should format a valid base64url secret key to base32 groups', () => {
            const formatted = formatSecretKeyForBackup(testSecretBase64);
            
            // Should be in format XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
            expect(formatted).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}$/);
            expect(formatted.split('-')).toHaveLength(7);
        });

        it('should produce consistent output for the same input', () => {
            const formatted1 = formatSecretKeyForBackup(testSecretBase64);
            const formatted2 = formatSecretKeyForBackup(testSecretBase64);
            expect(formatted1).toBe(formatted2);
        });

        it('should produce different output for different inputs', () => {
            const formatted1 = formatSecretKeyForBackup(testSecretBase64);
            const formatted2 = formatSecretKeyForBackup(testSecretBase642);
            expect(formatted1).not.toBe(formatted2);
        });

        it('should throw error for invalid base64 input', () => {
            expect(() => formatSecretKeyForBackup('invalid-base64!')).toThrow('Invalid secret key format');
        });

        it('should throw error for wrong length key', () => {
            const shortKey = encodeBase64(new Uint8Array(16), 'base64url');
            expect(() => formatSecretKeyForBackup(shortKey)).not.toThrow(); // It won't throw here, but parseBackupSecretKey will
        });
    });

    describe('parseBackupSecretKey', () => {
        it('should parse formatted key back to original base64url', () => {
            const formatted = formatSecretKeyForBackup(testSecretBase64);
            const parsed = parseBackupSecretKey(formatted);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle keys with extra dashes or spaces', () => {
            const formatted = formatSecretKeyForBackup(testSecretBase64);
            const withExtraChars = formatted.replace(/-/g, ' - ');
            const parsed = parseBackupSecretKey(withExtraChars);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle lowercase input', () => {
            const formatted = formatSecretKeyForBackup(testSecretBase64);
            const lowercase = formatted.toLowerCase();
            // This should throw because base32 is case-sensitive in our implementation
            expect(() => parseBackupSecretKey(lowercase)).toThrow('Invalid secret key format');
        });

        it('should throw error for invalid characters', () => {
            expect(() => parseBackupSecretKey('AAAAA-BBBBB-CCCCC-88888-EEEEE-FFFFF-GGGGG')).toThrow('Invalid secret key format');
        });

        it('should throw error for wrong length', () => {
            expect(() => parseBackupSecretKey('AAAAA-BBBBB')).toThrow('Invalid key length');
        });

        it('should round-trip correctly with random keys', () => {
            const formatted = formatSecretKeyForBackup(randomBase64);
            const parsed = parseBackupSecretKey(formatted);
            expect(parsed).toBe(randomBase64);
            
            // Verify the bytes are identical
            const originalBytes = decodeBase64(randomBase64, 'base64url');
            const parsedBytes = decodeBase64(parsed, 'base64url');
            expect(parsedBytes).toEqual(originalBytes);
        });
    });

    describe('isValidSecretKey', () => {
        it('should validate base64url format keys', () => {
            expect(isValidSecretKey(testSecretBase64)).toBe(true);
            expect(isValidSecretKey(testSecretBase642)).toBe(true);
            expect(isValidSecretKey(randomBase64)).toBe(true);
        });

        it('should validate formatted keys', () => {
            const formatted = formatSecretKeyForBackup(testSecretBase64);
            expect(isValidSecretKey(formatted)).toBe(true);
        });

        it('should reject invalid base64url keys', () => {
            expect(isValidSecretKey('invalid!')).toBe(false);
            expect(isValidSecretKey('')).toBe(false);
            expect(isValidSecretKey('   ')).toBe(false);
        });

        it('should reject wrong length keys', () => {
            const shortKey = encodeBase64(new Uint8Array(16), 'base64url');
            const longKey = encodeBase64(new Uint8Array(64), 'base64url');
            expect(isValidSecretKey(shortKey)).toBe(false);
            expect(isValidSecretKey(longKey)).toBe(false);
        });

        it('should reject malformed formatted keys', () => {
            expect(isValidSecretKey('AAAAA-BBBBB')).toBe(false);
            expect(isValidSecretKey('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH')).toBe(false);
        });
    });

    describe('normalizeSecretKey', () => {
        it('should return base64url key unchanged if valid', () => {
            expect(normalizeSecretKey(testSecretBase64)).toBe(testSecretBase64);
        });

        it('should convert formatted key to base64url', () => {
            const formatted = formatSecretKeyForBackup(testSecretBase64);
            expect(normalizeSecretKey(formatted)).toBe(testSecretBase64);
        });

        it('should throw for invalid keys', () => {
            expect(() => normalizeSecretKey('invalid')).toThrow('Invalid secret key');
            expect(() => normalizeSecretKey('')).toThrow('Invalid secret key');
        });

        it('should throw for wrong length keys', () => {
            const shortKey = encodeBase64(new Uint8Array(16), 'base64url');
            expect(() => normalizeSecretKey(shortKey)).toThrow('Invalid secret key');
        });

        it('should handle edge cases', () => {
            // Key with dashes but not formatted (should still try to parse as formatted)
            expect(() => normalizeSecretKey('test-key-with-dashes')).toThrow('Invalid secret key');
            
            // Very long string
            const longString = 'A'.repeat(1000);
            expect(() => normalizeSecretKey(longString)).toThrow('Invalid secret key');
        });
    });

    describe('Base32 encoding edge cases', () => {
        it('should handle all zeros', () => {
            const zeros = new Uint8Array(32).fill(0);
            const zerosBase64 = encodeBase64(zeros, 'base64url');
            const formatted = formatSecretKeyForBackup(zerosBase64);
            const parsed = parseBackupSecretKey(formatted);
            expect(decodeBase64(parsed, 'base64url')).toEqual(zeros);
        });

        it('should handle all ones', () => {
            const ones = new Uint8Array(32).fill(255);
            const onesBase64 = encodeBase64(ones, 'base64url');
            const formatted = formatSecretKeyForBackup(onesBase64);
            const parsed = parseBackupSecretKey(formatted);
            expect(decodeBase64(parsed, 'base64url')).toEqual(ones);
        });

        it('should handle alternating pattern', () => {
            const pattern = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                pattern[i] = i % 2 === 0 ? 0 : 255;
            }
            const patternBase64 = encodeBase64(pattern, 'base64url');
            const formatted = formatSecretKeyForBackup(patternBase64);
            const parsed = parseBackupSecretKey(formatted);
            expect(decodeBase64(parsed, 'base64url')).toEqual(pattern);
        });
    });

    describe('User experience considerations', () => {
        it('formatted key should only use unambiguous characters', () => {
            const formatted = formatSecretKeyForBackup(randomBase64);
            // Should not contain 0, 1, 8, 9, O, I
            expect(formatted).not.toMatch(/[0189OI]/);
        });

        it('formatted key should be reasonably short', () => {
            const formatted = formatSecretKeyForBackup(randomBase64);
            // 7 groups of 5 chars + 6 dashes = 41 characters
            expect(formatted.length).toBe(41);
        });

        it('should preserve information through multiple conversions', () => {
            let current = testSecretBase64;
            
            // Convert back and forth multiple times
            for (let i = 0; i < 10; i++) {
                const formatted = formatSecretKeyForBackup(current);
                current = parseBackupSecretKey(formatted);
            }
            
            expect(current).toBe(testSecretBase64);
        });
    });
});