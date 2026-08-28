import { describe, expect, it } from 'vitest';
import {
    decodeBase64,
    decryptWithDataKey,
    deriveKey,
    encodeBase64,
    encryptWithDataKey,
    getRandomBytes,
} from './encryption';

const DATA_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const DATA_KEY_VECTOR = 'ACAhIiMkJSYnKCkqK6kYzhUA9HUsIF41obN0kNv8a4K+vbRRk+s4s2ehb0Zf40lXFRlZpyQ=';

function toHex(value: Uint8Array): string {
    return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

describe('browser-safe encryption', () => {
    it('decrypts an existing AES-256-GCM bundle', () => {
        expect(decryptWithDataKey(decodeBase64(DATA_KEY_VECTOR), DATA_KEY)).toEqual({
            hello: 'world',
            n: 42,
        });
    });

    it('preserves the existing key derivation vector', () => {
        const seed = new TextEncoder().encode('test seed');
        expect(toHex(deriveKey(seed, 'test usage', ['child1', 'child2']))).toBe(
            '1011C097D2105D27362B987A631496BBF68B836124D1D072E9D1613C6028CF75',
        );
    });

    it('round-trips data without Node Buffer APIs', () => {
        const input = { text: 'hello', emoji: '🐾' };
        const key = getRandomBytes(32);
        const encrypted = encryptWithDataKey(input, key);
        expect(encodeBase64(encrypted)).not.toBe('');
        expect(decryptWithDataKey(encrypted, key)).toEqual(input);
    });
});
