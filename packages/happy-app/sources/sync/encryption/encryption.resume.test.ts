import { describe, expect, it, vi } from 'vitest';

// Key ownership/lifetime test; native cryptography is not exercised here.
vi.mock('@/encryption/deriveKey', () => ({ deriveKey: async () => new Uint8Array(32).fill(9) }));
vi.mock('@/encryption/libsodium.lib', () => ({ default: { crypto_box_seed_keypair: () => ({ publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) }) } }));
vi.mock('@/encryption/libsodium', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-id' }));
vi.mock('./encryptor', () => ({
    AES256Encryption: class {}, SecretBoxEncryption: class {},
}));

import { Encryption } from './encryption';

describe('resume data-key access', () => {
    it('exposes per-session keys only, never the account master or legacy blob key', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const firstKey = new Uint8Array(32).fill(1);
        const secondKey = new Uint8Array(32).fill(2);
        await encryption.initializeSessions(new Map([
            ['first', firstKey], ['second', secondKey], ['legacy', null],
        ]));
        expect(encryption.getSessionDataKey('first')).toEqual(firstKey);
        expect(encryption.getSessionDataKey('second')).toEqual(secondKey);
        expect(encryption.getSessionDataKey('legacy')).toBeNull();
        expect(encryption.getSessionDataKey('unknown')).toBeNull();

        encryption.removeSessionEncryption('first');
        expect(encryption.getSessionDataKey('first')).toBeNull();
        await encryption.initializeSessions(new Map([['first', null]]));
        expect(encryption.getSessionDataKey('first')).toBeNull();
    });
});