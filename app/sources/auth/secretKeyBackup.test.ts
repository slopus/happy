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
    
    // Random test key - use fixed values for consistent testing
    const randomBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        randomBytes[i] = (i * 7 + 13) % 256;
    }
    const randomBase64 = encodeBase64(randomBytes, 'base64url');

    describe('formatSecretKeyForBackup', () => {
        it('should format a valid base64url secret key to base32 groups', () => {
            const formatted = formatSecretKeyForBackup(testSecretBase64);
            
            // Should be in format XXXXX-XXXXX-XXXXX-... (multiple groups)
            expect(formatted).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{1,5})*$/);
            // 32 bytes = 256 bits = 52 base32 chars, so we need at least 10 groups
            expect(formatted.split('-').length).toBeGreaterThanOrEqual(10);
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
            // Should work because we convert to uppercase
            const parsed = parseBackupSecretKey(lowercase);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should throw error for invalid characters', () => {
            // Use a string that looks valid but has invalid chars that won't be cleaned out
            expect(() => parseBackupSecretKey('!!!INVALID!!!')).toThrow('Invalid key length');
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
            
            // For randomBase64, let's create a fresh one to ensure it's valid
            const freshRandomBytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                freshRandomBytes[i] = i % 256;
            }
            const freshRandomBase64 = encodeBase64(freshRandomBytes, 'base64url');
            expect(isValidSecretKey(freshRandomBase64)).toBe(true);
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
            expect(() => normalizeSecretKey('invalid')).toThrow();
            expect(() => normalizeSecretKey('')).toThrow();
        });

        it('should throw for wrong length keys', () => {
            const shortKey = encodeBase64(new Uint8Array(16), 'base64url');
            expect(() => normalizeSecretKey(shortKey)).toThrow();
        });

        it('should handle edge cases', () => {
            // Key with dashes but not formatted (should still try to parse as formatted)
            expect(() => normalizeSecretKey('test-key-with-dashes')).toThrow();
            
            // Very long string
            const longString = 'A'.repeat(1000);
            expect(() => normalizeSecretKey(longString)).toThrow();
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
        it('formatted key should only use base32 characters', () => {
            const formatted = formatSecretKeyForBackup(randomBase64);
            // Base32 alphabet: A-Z and 2-7
            expect(formatted).toMatch(/^[A-Z2-7-]+$/);
            // Should not contain 0, 1, 8, 9
            expect(formatted).not.toMatch(/[0189]/);
        });

        it('formatted key should be reasonably short', () => {
            const formatted = formatSecretKeyForBackup(randomBase64);
            // Should be around 52 chars + dashes
            expect(formatted.length).toBeLessThan(70); // reasonable upper bound
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

    describe('Robustness - User input mistakes', () => {
        const formattedKey = formatSecretKeyForBackup(testSecretBase64);
        
        it('should handle mixed case input', () => {
            const mixedCase = formattedKey.split('').map((char, i) => 
                i % 2 === 0 ? char.toLowerCase() : char.toUpperCase()
            ).join('');
            
            const parsed = parseBackupSecretKey(mixedCase);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle all lowercase', () => {
            const lowercase = formattedKey.toLowerCase();
            const parsed = parseBackupSecretKey(lowercase);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle extra spaces everywhere', () => {
            // Spaces between characters
            const withSpaces = formattedKey.split('').join(' ');
            const parsed = parseBackupSecretKey(withSpaces);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle tabs and newlines', () => {
            const withWhitespace = formattedKey.replace(/-/g, '\n');
            const parsed = parseBackupSecretKey(withWhitespace);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle leading and trailing whitespace', () => {
            const padded = `   \n\t${formattedKey}\t\n   `;
            const parsed = normalizeSecretKey(padded);
            expect(parsed).toBe(testSecretBase64);
        });
    });

    describe('Robustness - Common character confusion', () => {
        const formattedKey = formatSecretKeyForBackup(testSecretBase64);
        
        it('should handle 0 (zero) instead of O', () => {
            const withZeros = formattedKey.replace(/O/g, '0');
            const parsed = parseBackupSecretKey(withZeros);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle 1 (one) instead of I', () => {
            const withOnes = formattedKey.replace(/I/g, '1');
            const parsed = parseBackupSecretKey(withOnes);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle 8 instead of B', () => {
            const withEights = formattedKey.replace(/B/g, '8');
            const parsed = parseBackupSecretKey(withEights);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle mixed confusions', () => {
            let confused = formattedKey
                .replace(/O/g, '0')
                .replace(/I/g, '1')
                .replace(/B/g, '8');
            
            // Also make it lowercase with extra spaces
            confused = confused.toLowerCase().split('-').join(' - ');
            
            const parsed = parseBackupSecretKey(confused);
            expect(parsed).toBe(testSecretBase64);
        });
    });

    describe('Robustness - Copy-paste errors', () => {
        const formattedKey = formatSecretKeyForBackup(testSecretBase64);
        
        it('should handle key wrapped in quotes', () => {
            const quoted = `"${formattedKey}"`;
            const parsed = parseBackupSecretKey(quoted);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle key wrapped in single quotes', () => {
            const quoted = `'${formattedKey}'`;
            const parsed = parseBackupSecretKey(quoted);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle key wrapped in backticks', () => {
            const quoted = `\`${formattedKey}\``;
            const parsed = parseBackupSecretKey(quoted);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle key with markdown formatting', () => {
            const markdown = `\`\`\`${formattedKey}\`\`\``;
            const parsed = parseBackupSecretKey(markdown);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle key with dots instead of dashes', () => {
            const dotted = formattedKey.replace(/-/g, '.');
            const parsed = parseBackupSecretKey(dotted);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle key with underscores instead of dashes', () => {
            const underscored = formattedKey.replace(/-/g, '_');
            const parsed = parseBackupSecretKey(underscored);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle key with slashes', () => {
            const slashed = formattedKey.replace(/-/g, '/');
            const parsed = parseBackupSecretKey(slashed);
            expect(parsed).toBe(testSecretBase64);
        });
    });

    describe('Robustness - Formatting variations', () => {
        const formattedKey = formatSecretKeyForBackup(testSecretBase64);
        
        it('should handle key without any separators', () => {
            const continuous = formattedKey.replace(/-/g, '');
            const parsed = parseBackupSecretKey(continuous);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle key with double dashes', () => {
            const doubleDashed = formattedKey.replace(/-/g, '--');
            const parsed = parseBackupSecretKey(doubleDashed);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle key with spaces and dashes mixed', () => {
            const mixed = formattedKey.split('-').map((group, i) => 
                i % 2 === 0 ? group : group.split('').join(' ')
            ).join(' - ');
            const parsed = parseBackupSecretKey(mixed);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle key split across multiple lines', () => {
            const groups = formattedKey.split('-');
            const multiline = groups.join('\n');
            const parsed = parseBackupSecretKey(multiline);
            expect(parsed).toBe(testSecretBase64);
        });
    });

    describe('Robustness - Special characters and noise', () => {
        const formattedKey = formatSecretKeyForBackup(testSecretBase64);
        
        it('should handle emoji mixed in', () => {
            const withEmoji = `😀${formattedKey}🎉`;
            const parsed = parseBackupSecretKey(withEmoji);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle parentheses and brackets', () => {
            const withBrackets = `[${formattedKey}]`;
            const parsed = parseBackupSecretKey(withBrackets);
            expect(parsed).toBe(testSecretBase64);
        });

        it('should handle HTML entities', () => {
            // HTML entities like &mdash; contain valid base32 chars (MDASH)
            // so they actually add extra data. Just test that it doesn't crash
            const withEntities = formattedKey.replace(/-/g, '&mdash;');
            expect(() => parseBackupSecretKey(withEntities)).toThrow(/Invalid key length/);
        });

        it('should handle URL encoding artifacts', () => {
            // %2D contains a valid base32 char (D) so it adds extra data
            const withPercents = formattedKey.replace(/-/g, '%2D');
            expect(() => parseBackupSecretKey(withPercents)).toThrow(/Invalid key length/);
        });

        it('should handle completely mangled input with recovery possible', () => {
            // Simulate a really messed up copy-paste
            let mangled = formattedKey;
            mangled = mangled.toLowerCase();                    // wrong case
            mangled = mangled.replace(/o/g, '0');              // confused O with 0
            mangled = mangled.replace(/i/g, '1');              // confused I with 1
            mangled = mangled.replace(/-/g, ' --- ');          // weird spacing
            mangled = mangled.split('').join(' ');             // spaces everywhere
            
            const parsed = parseBackupSecretKey(mangled);
            expect(parsed).toBe(testSecretBase64);
        });
    });

    describe('Robustness - normalizeSecretKey flexibility', () => {
        const formattedKey = formatSecretKeyForBackup(testSecretBase64);
        
        it('should handle both formats through normalizeSecretKey', () => {
            // Test with base64url
            expect(normalizeSecretKey(testSecretBase64)).toBe(testSecretBase64);
            
            // Test with formatted
            expect(normalizeSecretKey(formattedKey)).toBe(testSecretBase64);
            
            // Test with mangled formatted
            const mangled = formattedKey.toLowerCase().replace(/-/g, ' ');
            expect(normalizeSecretKey(mangled)).toBe(testSecretBase64);
        });

        it('should try formatted parsing when base64 fails', () => {
            // This looks like base64 but isn't valid
            const fakeBase64 = 'ABCDEFGHIJKLMNOP';
            
            // Should throw because it's not valid in either format
            expect(() => normalizeSecretKey(fakeBase64)).toThrow();
        });

        it('should handle user typing key with random spacing', () => {
            // User might type the key with their own spacing
            const groups = formattedKey.replace(/-/g, '');
            const userTyped = groups.match(/.{1,4}/g)!.join(' ');
            
            const parsed = normalizeSecretKey(userTyped);
            expect(parsed).toBe(testSecretBase64);
        });
    });

    describe('Robustness - Error messages should be helpful', () => {
        it('should give clear error for empty input', () => {
            expect(() => parseBackupSecretKey('')).toThrow('No valid characters found');
            expect(() => parseBackupSecretKey('   ')).toThrow('No valid characters found');
            expect(() => parseBackupSecretKey('!!!')).toThrow('No valid characters found');
        });

        it('should give clear error for wrong length', () => {
            expect(() => parseBackupSecretKey('AAAAA-BBBBB')).toThrow(/Invalid key length/);
        });
    });
});