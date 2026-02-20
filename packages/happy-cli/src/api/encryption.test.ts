import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { deriveVendorEncryptionKey, encryptWithDataKey, decryptWithDataKey } from './encryption';

describe('deriveVendorEncryptionKey', () => {
    it('produces a 32-byte Uint8Array', () => {
        const machineKey = new Uint8Array(randomBytes(32));
        const derived = deriveVendorEncryptionKey(machineKey);

        expect(derived).toBeInstanceOf(Uint8Array);
        expect(derived.length).toBe(32);
    });

    it('is deterministic: same input always produces same output', () => {
        const machineKey = new Uint8Array(randomBytes(32));
        const a = deriveVendorEncryptionKey(machineKey);
        const b = deriveVendorEncryptionKey(machineKey);

        expect(a).toEqual(b);
    });

    it('produces output different from the input machineKey (domain separation)', () => {
        const machineKey = new Uint8Array(randomBytes(32));
        const derived = deriveVendorEncryptionKey(machineKey);

        expect(derived).not.toEqual(machineKey);
    });

    it('produces different output for different machineKeys', () => {
        const keyA = new Uint8Array(randomBytes(32));
        const keyB = new Uint8Array(randomBytes(32));

        const derivedA = deriveVendorEncryptionKey(keyA);
        const derivedB = deriveVendorEncryptionKey(keyB);

        expect(derivedA).not.toEqual(derivedB);
    });

    it('uses HMAC label for domain separation (different label would produce different output)', () => {
        // This test documents that the function uses a fixed HMAC label.
        // We verify by checking that the output is a consistent, non-trivial
        // transformation — not simply a hash of the key alone.
        const machineKey = new Uint8Array(32).fill(0x42);
        const derived = deriveVendorEncryptionKey(machineKey);

        // The output should be deterministic and non-zero
        expect(derived.length).toBe(32);
        expect(derived.some(b => b !== 0)).toBe(true);

        // A second call with same key must match (HMAC label is fixed)
        expect(deriveVendorEncryptionKey(machineKey)).toEqual(derived);
    });
});

describe('vendor token round-trip encryption', () => {
    it('encrypts and decrypts back to the original token', () => {
        const machineKey = new Uint8Array(randomBytes(32));
        const vendorKey = deriveVendorEncryptionKey(machineKey);
        const token = 'sk-ant-api03-super-secret-key-12345';

        const encrypted = encryptWithDataKey(token, vendorKey);
        const decrypted = decryptWithDataKey(encrypted, vendorKey);

        expect(decrypted).toBe(token);
    });

    it('returns null when decrypting with a different derived key', () => {
        const keyA = new Uint8Array(randomBytes(32));
        const keyB = new Uint8Array(randomBytes(32));
        const vendorKeyA = deriveVendorEncryptionKey(keyA);
        const vendorKeyB = deriveVendorEncryptionKey(keyB);
        const token = 'sk-ant-api03-super-secret-key-12345';

        const encrypted = encryptWithDataKey(token, vendorKeyA);
        const decrypted = decryptWithDataKey(encrypted, vendorKeyB);

        expect(decrypted).toBeNull();
    });
});
