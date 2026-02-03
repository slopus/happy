import { describe, it, expect } from '@/dev/testRunner';
import { encodeBase64, decodeBase64 } from './base64';
import { getRandomBytes } from 'expo-crypto';

describe('Base64 Tests', () => {
    describe('Standard Base64 Encoding/Decoding', () => {
        it('should encode and decode empty array', async () => {
            const input = new Uint8Array([]);
            const encoded = encodeBase64(input);
            expect(encoded).toEqual('');
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });

        it('should encode and decode single byte', async () => {
            const input = new Uint8Array([72]); // 'H'
            const encoded = encodeBase64(input);
            expect(encoded).toEqual('SA==');
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });

        it('should encode and decode "Hello"', async () => {
            const input = new Uint8Array([72, 101, 108, 108, 111]);
            const encoded = encodeBase64(input);
            expect(encoded).toEqual('SGVsbG8=');
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });

        it('should encode and decode "Hello, World!"', async () => {
            const input = new Uint8Array([72, 101, 108, 108, 111, 44, 32, 87, 111, 114, 108, 100, 33]);
            const encoded = encodeBase64(input);
            expect(encoded).toEqual('SGVsbG8sIFdvcmxkIQ==');
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });

        it('should handle binary data with edge values', async () => {
            const input = new Uint8Array([0, 1, 2, 3, 252, 253, 254, 255]);
            const encoded = encodeBase64(input);
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });

        it('should handle all padding cases', async () => {
            // No padding (3 bytes)
            const input1 = new Uint8Array([1, 2, 3]);
            const encoded1 = encodeBase64(input1);
            expect(encoded1).toEqual('AQID');
            expect(decodeBase64(encoded1)).toEqual(input1);

            // 2 padding chars (4 bytes)
            const input2 = new Uint8Array([1, 2, 3, 4]);
            const encoded2 = encodeBase64(input2);
            expect(encoded2).toEqual('AQIDBA==');
            expect(decodeBase64(encoded2)).toEqual(input2);

            // 1 padding char (5 bytes)
            const input3 = new Uint8Array([1, 2, 3, 4, 5]);
            const encoded3 = encodeBase64(input3);
            expect(encoded3).toEqual('AQIDBAU=');
            expect(decodeBase64(encoded3)).toEqual(input3);
        });

        it('should encode and decode 32-byte key', async () => {
            const input = new Uint8Array([
                25, 98, 84, 190, 50, 194, 51, 115, 197, 46, 112, 77,
                155, 180, 158, 245, 129, 17, 92, 203, 118, 244, 18, 70,
                144, 34, 83, 84, 123, 21, 151, 61
            ]);
            const encoded = encodeBase64(input);
            expect(encoded).toEqual('GWJUvjLCM3PFLnBNm7Se9YERXMt29BJGkCJTVHsVlz0=');
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });

        it('should handle text encoding round-trip', async () => {
            const text = 'Hello, 世界! 🌍';
            const input = new TextEncoder().encode(text);
            const encoded = encodeBase64(input);
            expect(typeof encoded).toEqual('string');
            const decoded = decodeBase64(encoded);
            const decodedText = new TextDecoder().decode(decoded);
            expect(decodedText).toEqual(text);
        });

        it('should handle random data round-trip', async () => {
            const input = getRandomBytes(100);
            const encoded = encodeBase64(input);
            expect(typeof encoded).toEqual('string');
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });

        it('should handle large data', async () => {
            const input = getRandomBytes(1024);
            const encoded = encodeBase64(input);
            expect(typeof encoded).toEqual('string');
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });
    });

    describe('Base64URL Encoding/Decoding', () => {
        it('should encode and decode with URL-safe characters', async () => {
            const input = new Uint8Array([62, 63, 62, 63]);
            const encoded = encodeBase64(input, 'base64url');
            expect(encoded).toEqual('Pj8-Pw'); // No padding, - and _ instead of + and /
            const decoded = decodeBase64(encoded, 'base64url');
            expect(decoded).toEqual(input);
        });

        it('should encode without padding in base64url', async () => {
            const input = new Uint8Array([72, 101, 108, 108, 111]);
            const encoded = encodeBase64(input, 'base64url');
            expect(encoded).toEqual('SGVsbG8'); // No '=' padding
            const decoded = decodeBase64(encoded, 'base64url');
            expect(decoded).toEqual(input);
        });

        it('should handle all padding cases for base64url', async () => {
            // No padding needed (3 bytes)
            const input1 = new Uint8Array([1, 2, 3]);
            const encoded1 = encodeBase64(input1, 'base64url');
            expect(encoded1).toEqual('AQID');
            expect(decodeBase64(encoded1, 'base64url')).toEqual(input1);

            // Would have 2 padding chars in base64 (4 bytes)
            const input2 = new Uint8Array([1, 2, 3, 4]);
            const encoded2 = encodeBase64(input2, 'base64url');
            expect(encoded2).toEqual('AQIDBA'); // No '=='
            expect(decodeBase64(encoded2, 'base64url')).toEqual(input2);

            // Would have 1 padding char in base64 (5 bytes)
            const input3 = new Uint8Array([1, 2, 3, 4, 5]);
            const encoded3 = encodeBase64(input3, 'base64url');
            expect(encoded3).toEqual('AQIDBAU'); // No '='
            expect(decodeBase64(encoded3, 'base64url')).toEqual(input3);
        });

        it('should handle binary data with URL-unsafe chars', async () => {
            const input = new Uint8Array([252, 253, 254, 255]);
            const encoded = encodeBase64(input, 'base64url');
            expect(encoded).toEqual('_P3-_w'); // _ instead of /, - instead of +, no padding
            const decoded = decodeBase64(encoded, 'base64url');
            expect(decoded).toEqual(input);
        });

        it('should encode and decode 32-byte key in base64url', async () => {
            const input = new Uint8Array([
                25, 98, 84, 190, 50, 194, 51, 115, 197, 46, 112, 77,
                155, 180, 158, 245, 129, 17, 92, 203, 118, 244, 18, 70,
                144, 34, 83, 84, 123, 21, 151, 61
            ]);
            const encoded = encodeBase64(input, 'base64url');
            expect(encoded).toEqual('GWJUvjLCM3PFLnBNm7Se9YERXMt29BJGkCJTVHsVlz0'); // No padding
            const decoded = decodeBase64(encoded, 'base64url');
            expect(decoded).toEqual(input);
        });

        it('should handle random data round-trip in base64url', async () => {
            const input = getRandomBytes(100);
            const encoded = encodeBase64(input, 'base64url');
            expect(typeof encoded).toEqual('string');
            expect(encoded.indexOf('+')).toEqual(-1); // No + chars
            expect(encoded.indexOf('/')).toEqual(-1); // No / chars
            expect(encoded.indexOf('=')).toEqual(-1); // No = chars
            const decoded = decodeBase64(encoded, 'base64url');
            expect(decoded).toEqual(input);
        });
    });

    describe('Cross-format compatibility', () => {
        it('should correctly convert between base64 and base64url', async () => {
            const input = getRandomBytes(50);
            
            // Encode as base64
            const base64 = encodeBase64(input);
            
            // Decode as base64 and re-encode as base64url
            const decoded = decodeBase64(base64);
            const base64url = encodeBase64(decoded, 'base64url');
            
            // Decode base64url and verify it matches original
            const final = decodeBase64(base64url, 'base64url');
            expect(final).toEqual(input);
        });

        it('should handle edge case characters that differ between formats', async () => {
            // Create data that will produce + and / in base64
            const input = new Uint8Array([251, 255]); // Will produce /
            
            const base64 = encodeBase64(input);
            const base64url = encodeBase64(input, 'base64url');
            
            // Verify they differ in the expected way
            expect(base64.indexOf('/')).toBeGreaterThan(-1);
            expect(base64url.indexOf('_')).toBeGreaterThan(-1);
            expect(base64url.indexOf('/')).toEqual(-1);
            
            // Both should decode to same value
            expect(decodeBase64(base64)).toEqual(input);
            expect(decodeBase64(base64url, 'base64url')).toEqual(input);
        });
    });

    describe('Performance and edge cases', () => {
        it('should handle all byte values 0-255', async () => {
            const input = new Uint8Array(256);
            for (let i = 0; i < 256; i++) {
                input[i] = i;
            }
            
            const encoded = encodeBase64(input);
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
            
            const encodedUrl = encodeBase64(input, 'base64url');
            const decodedUrl = decodeBase64(encodedUrl, 'base64url');
            expect(decodedUrl).toEqual(input);
        });

        it('should handle zero bytes correctly', async () => {
            const input = new Uint8Array([0, 0, 0, 0]);
            const encoded = encodeBase64(input);
            expect(encoded).toEqual('AAAAAA==');
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });

        it('should handle maximum byte values', async () => {
            const input = new Uint8Array([255, 255, 255, 255]);
            const encoded = encodeBase64(input);
            expect(encoded).toEqual('/////w==');
            const decoded = decodeBase64(encoded);
            expect(decoded).toEqual(input);
        });
    });
});