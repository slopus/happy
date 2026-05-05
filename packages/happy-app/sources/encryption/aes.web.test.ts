/**
 * Round-trip tests for aes.web.ts running against the same crypto.subtle
 * that web-secure-encryption uses on the web build, so a successful round
 * trip here implies wire compatibility with what rn-encryption emits on
 * the native side (which uses the AES.GCM SealedBox combined-format:
 * 12-byte nonce + ciphertext + 16-byte tag).
 */
import { describe, it, expect } from 'vitest';
import {
    encryptAESGCMString,
    decryptAESGCMString,
    encryptAESGCM,
    decryptAESGCM,
} from './aes.web';
import { encodeBase64 } from './base64';

function randomKeyB64(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return encodeBase64(bytes);
}

describe('aes.web', () => {
    it('round-trips a string', async () => {
        const key = randomKeyB64();
        const plain = JSON.stringify({ msg: 'Hello, World!', n: 42 });
        const encrypted = await encryptAESGCMString(plain, key);
        expect(typeof encrypted).toBe('string');
        const decrypted = await decryptAESGCMString(encrypted, key);
        expect(decrypted).toBe(plain);
    });

    it('produces a fresh IV per call (no two ciphertexts equal)', async () => {
        const key = randomKeyB64();
        const a = await encryptAESGCMString('same', key);
        const b = await encryptAESGCMString('same', key);
        expect(a).not.toBe(b);
    });

    it('rejects ciphertext encrypted under a different key', async () => {
        const k1 = randomKeyB64();
        const k2 = randomKeyB64();
        const encrypted = await encryptAESGCMString('secret', k1);
        const result = await decryptAESGCMString(encrypted, k2);
        expect(result).toBeNull();
    });

    it('rejects truncated ciphertext gracefully', async () => {
        const key = randomKeyB64();
        const encrypted = await encryptAESGCMString('hello', key);
        const result = await decryptAESGCMString(encrypted.slice(0, 4), key);
        expect(result).toBeNull();
    });

    it('round-trips a Uint8Array via the bytes API', async () => {
        const key = randomKeyB64();
        const data = new TextEncoder().encode('Hello, World!');
        const encrypted = await encryptAESGCM(data, key);
        expect(encrypted).toBeInstanceOf(Uint8Array);
        const decrypted = await decryptAESGCM(encrypted, key);
        expect(decrypted).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(decrypted!)).toBe('Hello, World!');
    });

    it('produces wire format: 12-byte IV prefix + ciphertext + 16-byte tag', async () => {
        const key = randomKeyB64();
        const encrypted = await encryptAESGCMString('a', key);
        // base64 payload = IV(12) + ciphertext("a" → 1 byte) + GCM tag(16) = 29 bytes
        // base64 encoded length for 29 bytes = ceil(29/3)*4 = 40 chars (with padding)
        const decoded = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
        expect(decoded.length).toBe(12 + 1 + 16);
    });
});
