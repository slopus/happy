import { describe, it, expect } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    encodeBase64,
    decodeBase64,
    encodeBase64Url,
    decodeBase64Url,
    getRandomBytes,
    hmac_sha512,
    deriveSecretKeyTreeRoot,
    deriveSecretKeyTreeChild,
    deriveKey,
    deriveContentKeyPair,
    encryptWithDataKey,
    decryptWithDataKey,
    encryptLegacy,
    decryptLegacy,
    encrypt,
    decrypt,
    libsodiumEncryptForPublicKey,
    decryptBoxBundle,
    authChallenge,
} from './encryption';

// Helper: hex encode for test vector comparison
function toHex(buf: Uint8Array): string {
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

describe('base64 encoding/decoding', () => {
    it('round-trips standard base64', () => {
        const data = new Uint8Array([0, 1, 2, 255, 128, 64]);
        const encoded = encodeBase64(data);
        const decoded = decodeBase64(encoded);
        expect(decoded).toEqual(data);
    });

    it('round-trips base64url', () => {
        const data = new Uint8Array([0, 1, 2, 255, 128, 64]);
        const encoded = encodeBase64Url(data);
        const decoded = decodeBase64Url(encoded);
        expect(decoded).toEqual(data);
    });

    it('base64url does not contain +, /, or =', () => {
        // Use data that produces +, /, and padding in standard base64
        const data = new Uint8Array([62, 63, 255, 254, 253]);
        const encoded = encodeBase64Url(data);
        expect(encoded).not.toContain('+');
        expect(encoded).not.toContain('/');
        expect(encoded).not.toContain('=');
    });

    it('encodes empty buffer', () => {
        const data = new Uint8Array([]);
        expect(encodeBase64(data)).toBe('');
        expect(decodeBase64('')).toEqual(data);
    });

    it('decodes known base64 value', () => {
        // "Hello" in base64 is "SGVsbG8="
        const decoded = decodeBase64('SGVsbG8=');
        expect(new TextDecoder().decode(decoded)).toBe('Hello');
    });

    it('base64url round-trips with characters that differ from standard', () => {
        // Bytes that produce + and / in standard base64
        const data = new Uint8Array([251, 239, 190]);
        const standard = encodeBase64(data);
        const urlSafe = encodeBase64Url(data);
        // Standard should have + or /
        expect(standard).toMatch(/[+/]/);
        // URL-safe should not
        expect(urlSafe).not.toMatch(/[+/=]/);
        // Both should decode to same data
        expect(decodeBase64(standard)).toEqual(data);
        expect(decodeBase64Url(urlSafe)).toEqual(data);
    });
});

describe('HMAC-SHA512', () => {
    it('produces 64-byte output', () => {
        const key = new TextEncoder().encode('key');
        const data = new TextEncoder().encode('data');
        const result = hmac_sha512(key, data);
        expect(result.length).toBe(64);
    });

    it('is deterministic', () => {
        const key = new TextEncoder().encode('key');
        const data = new TextEncoder().encode('data');
        const r1 = hmac_sha512(key, data);
        const r2 = hmac_sha512(key, data);
        expect(r1).toEqual(r2);
    });

    it('different keys produce different outputs', () => {
        const data = new TextEncoder().encode('data');
        const r1 = hmac_sha512(new TextEncoder().encode('key1'), data);
        const r2 = hmac_sha512(new TextEncoder().encode('key2'), data);
        expect(r1).not.toEqual(r2);
    });
});

describe('key derivation', () => {
    it('deriveSecretKeyTreeRoot produces 32-byte key and 32-byte chainCode', () => {
        const seed = new TextEncoder().encode('test seed');
        const result = deriveSecretKeyTreeRoot(seed, 'test usage');
        expect(result.key.length).toBe(32);
        expect(result.chainCode.length).toBe(32);
    });

    it('matches known test vector for root key', () => {
        const seed = new TextEncoder().encode('test seed');
        const result = deriveSecretKeyTreeRoot(seed, 'test usage');
        expect(toHex(result.key)).toBe('E6E55652456F9FE47D6FF46CA3614E85B499F77E7B340FBBB1553307CEDC1E74');
    });

    it('matches known test vector for full derivation path', () => {
        const seed = new TextEncoder().encode('test seed');
        const key = deriveKey(seed, 'test usage', ['child1', 'child2']);
        expect(toHex(key)).toBe('1011C097D2105D27362B987A631496BBF68B836124D1D072E9D1613C6028CF75');
    });

    it('deriveSecretKeyTreeChild produces correct structure', () => {
        const seed = new TextEncoder().encode('test seed');
        const root = deriveSecretKeyTreeRoot(seed, 'test usage');
        const child = deriveSecretKeyTreeChild(root.chainCode, 'child1');
        expect(child.key.length).toBe(32);
        expect(child.chainCode.length).toBe(32);
    });

    it('deriveKey with empty path returns root key', () => {
        const seed = new TextEncoder().encode('test seed');
        const root = deriveSecretKeyTreeRoot(seed, 'test usage');
        const key = deriveKey(seed, 'test usage', []);
        expect(key).toEqual(root.key);
    });

    it('deriveContentKeyPair returns 32-byte public and secret keys', () => {
        const secret = getRandomBytes(32);
        const kp = deriveContentKeyPair(secret);
        expect(kp.publicKey.length).toBe(32);
        expect(kp.secretKey.length).toBe(32);
    });

    it('deriveContentKeyPair is deterministic', () => {
        const secret = getRandomBytes(32);
        const kp1 = deriveContentKeyPair(secret);
        const kp2 = deriveContentKeyPair(secret);
        expect(kp1.publicKey).toEqual(kp2.publicKey);
        expect(kp1.secretKey).toEqual(kp2.secretKey);
    });
});

describe('AES-256-GCM encryption', () => {
    it('encrypt/decrypt round-trip', () => {
        const key = getRandomBytes(32);
        const data = { hello: 'world', nested: { arr: [1, 2, 3] } };
        const encrypted = encryptWithDataKey(data, key);
        const decrypted = decryptWithDataKey(encrypted, key);
        expect(decrypted).toEqual(data);
    });

    it('encrypted bundle starts with version byte 0', () => {
        const key = getRandomBytes(32);
        const encrypted = encryptWithDataKey('test', key);
        expect(encrypted[0]).toBe(0);
    });

    it('decryption fails with wrong key', () => {
        const key1 = getRandomBytes(32);
        const key2 = getRandomBytes(32);
        const encrypted = encryptWithDataKey('test', key1);
        expect(decryptWithDataKey(encrypted, key2)).toBeNull();
    });

    it('decryption fails with tampered data', () => {
        const key = getRandomBytes(32);
        const encrypted = encryptWithDataKey('test', key);
        encrypted[20] ^= 0xff; // flip a byte in ciphertext
        expect(decryptWithDataKey(encrypted, key)).toBeNull();
    });

    it('decryption returns null for too-short bundle', () => {
        const key = getRandomBytes(32);
        expect(decryptWithDataKey(new Uint8Array(10), key)).toBeNull();
    });

    it('decryption returns null for wrong version', () => {
        const key = getRandomBytes(32);
        const encrypted = encryptWithDataKey('test', key);
        encrypted[0] = 1; // wrong version
        expect(decryptWithDataKey(encrypted, key)).toBeNull();
    });

    it('handles string data', () => {
        const key = getRandomBytes(32);
        const data = 'hello world';
        const decrypted = decryptWithDataKey(encryptWithDataKey(data, key), key);
        expect(decrypted).toBe('hello world');
    });

    it('handles numeric data', () => {
        const key = getRandomBytes(32);
        const decrypted = decryptWithDataKey(encryptWithDataKey(42, key), key);
        expect(decrypted).toBe(42);
    });
});

describe('legacy encryption', () => {
    it('encrypt/decrypt round-trip', () => {
        const secret = getRandomBytes(32);
        const data = { message: 'hello', items: [1, 2, 3] };
        const encrypted = encryptLegacy(data, secret);
        const decrypted = decryptLegacy(encrypted, secret);
        expect(decrypted).toEqual(data);
    });

    it('decryption fails with wrong key', () => {
        const secret1 = getRandomBytes(32);
        const secret2 = getRandomBytes(32);
        const encrypted = encryptLegacy('test', secret1);
        expect(decryptLegacy(encrypted, secret2)).toBeNull();
    });

    it('encrypted data starts with 24-byte nonce', () => {
        const secret = getRandomBytes(32);
        const encrypted = encryptLegacy('test', secret);
        // Nonce is 24 bytes, followed by encrypted data
        expect(encrypted.length).toBeGreaterThan(24);
    });

    it('handles string data', () => {
        const secret = getRandomBytes(32);
        const decrypted = decryptLegacy(encryptLegacy('hello', secret), secret);
        expect(decrypted).toBe('hello');
    });
});

describe('encrypt/decrypt dispatcher', () => {
    it('dispatches to dataKey variant', () => {
        const key = getRandomBytes(32);
        const data = { test: true };
        const encrypted = encrypt(key, 'dataKey', data);
        expect(encrypted[0]).toBe(0); // AES-GCM version byte
        expect(decrypt(key, 'dataKey', encrypted)).toEqual(data);
    });

    it('dispatches to legacy variant', () => {
        const key = getRandomBytes(32);
        const data = { test: true };
        const encrypted = encrypt(key, 'legacy', data);
        expect(decrypt(key, 'legacy', encrypted)).toEqual(data);
    });

    it('cross-variant decryption fails', () => {
        const key = getRandomBytes(32);
        const encrypted = encrypt(key, 'dataKey', 'test');
        // Trying to decrypt dataKey with legacy should fail
        expect(decrypt(key, 'legacy', encrypted)).toBeNull();
    });
});

describe('libsodiumEncryptForPublicKey + decryptBoxBundle', () => {
    it('round-trip encryption/decryption', () => {
        const recipientKeyPair = tweetnacl.box.keyPair();
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const encrypted = libsodiumEncryptForPublicKey(data, recipientKeyPair.publicKey);
        const decrypted = decryptBoxBundle(encrypted, recipientKeyPair.secretKey);
        expect(decrypted).toEqual(data);
    });

    it('bundle has correct structure (32 pubkey + 24 nonce + ciphertext)', () => {
        const recipientKeyPair = tweetnacl.box.keyPair();
        const data = new Uint8Array([1, 2, 3]);
        const encrypted = libsodiumEncryptForPublicKey(data, recipientKeyPair.publicKey);
        // Minimum: 32 (pubkey) + 24 (nonce) + ciphertext (data + MAC overhead)
        expect(encrypted.length).toBeGreaterThan(56);
    });

    it('decryption fails with wrong secret key', () => {
        const recipientKeyPair = tweetnacl.box.keyPair();
        const wrongKeyPair = tweetnacl.box.keyPair();
        const data = new Uint8Array([1, 2, 3]);
        const encrypted = libsodiumEncryptForPublicKey(data, recipientKeyPair.publicKey);
        expect(decryptBoxBundle(encrypted, wrongKeyPair.secretKey)).toBeNull();
    });

    it('decryption returns null for too-short bundle', () => {
        const keyPair = tweetnacl.box.keyPair();
        expect(decryptBoxBundle(new Uint8Array(10), keyPair.secretKey)).toBeNull();
    });

    it('works with empty data', () => {
        const recipientKeyPair = tweetnacl.box.keyPair();
        const data = new Uint8Array([]);
        const encrypted = libsodiumEncryptForPublicKey(data, recipientKeyPair.publicKey);
        const decrypted = decryptBoxBundle(encrypted, recipientKeyPair.secretKey);
        expect(decrypted).toEqual(data);
    });

    it('works with deriveContentKeyPair keys', () => {
        const secret = getRandomBytes(32);
        const contentKeyPair = deriveContentKeyPair(secret);
        const data = new Uint8Array([10, 20, 30]);
        const encrypted = libsodiumEncryptForPublicKey(data, contentKeyPair.publicKey);
        const decrypted = decryptBoxBundle(encrypted, contentKeyPair.secretKey);
        expect(decrypted).toEqual(data);
    });
});

describe('authChallenge', () => {
    it('returns challenge, publicKey, and signature with correct sizes', () => {
        const secret = getRandomBytes(32);
        const result = authChallenge(secret);
        expect(result.challenge.length).toBe(32);
        expect(result.publicKey.length).toBe(32);
        expect(result.signature.length).toBe(64);
    });

    it('signature is verifiable with tweetnacl.sign.detached.verify', () => {
        const secret = getRandomBytes(32);
        const result = authChallenge(secret);
        const valid = tweetnacl.sign.detached.verify(result.challenge, result.signature, result.publicKey);
        expect(valid).toBe(true);
    });

    it('signature fails verification with wrong publicKey', () => {
        const secret1 = getRandomBytes(32);
        const secret2 = getRandomBytes(32);
        const result1 = authChallenge(secret1);
        const result2 = authChallenge(secret2);
        const valid = tweetnacl.sign.detached.verify(result1.challenge, result1.signature, result2.publicKey);
        expect(valid).toBe(false);
    });

    it('is deterministic for publicKey given same secret', () => {
        const secret = getRandomBytes(32);
        const r1 = authChallenge(secret);
        const r2 = authChallenge(secret);
        expect(r1.publicKey).toEqual(r2.publicKey);
        // challenge should differ (random)
        expect(r1.challenge).not.toEqual(r2.challenge);
    });
});

describe('getRandomBytes', () => {
    it('returns correct length', () => {
        expect(getRandomBytes(16).length).toBe(16);
        expect(getRandomBytes(32).length).toBe(32);
        expect(getRandomBytes(0).length).toBe(0);
    });

    it('produces different values on successive calls', () => {
        const a = getRandomBytes(32);
        const b = getRandomBytes(32);
        expect(a).not.toEqual(b);
    });
});
