import { describe, it, expect } from 'vitest';
import { encodeBase64, decodeBase64 } from './base64';

describe('encodeBase64 large buffers', () => {
    it('encodes a 1MB buffer without stack overflow', () => {
        const size = 1024 * 1024;
        const input = new Uint8Array(size);
        for (let i = 0; i < size; i++) input[i] = (i * 37) % 256;

        const encoded = encodeBase64(input);
        const decoded = decodeBase64(encoded);

        expect(decoded.length).toBe(size);
        expect(decoded[0]).toBe(input[0]);
        expect(decoded[size - 1]).toBe(input[size - 1]);
    });

    it('encodes a 5MB buffer without stack overflow', () => {
        const size = 5 * 1024 * 1024;
        const input = new Uint8Array(size);
        for (let i = 0; i < size; i++) input[i] = i & 0xff;

        const encoded = encodeBase64(input);
        const decoded = decodeBase64(encoded);

        expect(decoded.length).toBe(size);
        expect(decoded[size - 1]).toBe(input[size - 1]);
    });

    it('produces identical output to the small-buffer path at the chunk boundary', () => {
        for (const size of [8191, 8192, 8193, 16383, 16384, 16385]) {
            const input = new Uint8Array(size);
            for (let i = 0; i < size; i++) input[i] = (i * 17 + 3) & 0xff;
            const decoded = decodeBase64(encodeBase64(input));
            expect(decoded).toEqual(input);
        }
    });
});
