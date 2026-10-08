import { describe, expect, it } from 'vitest';
import { deriveContentKeyPair, encodeBase64, libsodiumEncryptForPublicKey } from './encryption';
import { resolveRecordEncryption, tryResolveRecordEncryption } from './records';
import type { TrustedRecordKeyCredentials } from '../client/types';

const key = new Uint8Array(32).fill(7);
const scoped: TrustedRecordKeyCredentials = {
    token: 'fixture',
    resolveRecordKey: record => record.id === 'known' ? { key, variant: record.dataEncryptionKey ? 'dataKey' : 'legacy' } : null,
};

describe('trusted record keys', () => {
    it.each(['legacy', 'dataKey'] as const)('resolves %s keys without requiring owner secrets', variant => {
        const record = { id: 'known', dataEncryptionKey: variant === 'legacy' ? null : 'sealed-owner-key' };
        const result = resolveRecordEncryption(record, scoped, 'session');
        expect(result).toEqual({ key, variant });
        expect(result.key).not.toBe(key);
    });
    it('omits unknown records from snapshots and rejects point access without fallback', () => {
        const record = { id: 'other-machine-session', dataEncryptionKey: null };
        expect(tryResolveRecordEncryption(record, scoped, 'session')).toBeNull();
        expect(() => resolveRecordEncryption(record, scoped, 'session')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    });
    it('rejects incompatible key variants and malformed keys', () => {
        for (const encryption of [{ key, variant: 'legacy' as const }, { key: new Uint8Array(16), variant: 'dataKey' as const }]) {
            expect(() => resolveRecordEncryption({ id: 'known', dataEncryptionKey: 'wrapped' }, {
                token: 'fixture', resolveRecordKey: () => encryption,
            }, 'session')).toThrowError(expect.objectContaining({ code: 'DECRYPTION_FAILED' }));
        }
    });
    it('preserves ordinary legacy and encrypted owner-key lookup', () => {
        const contentKeyPair = deriveContentKeyPair(key);
        const owner = { token: 'fixture', secret: key, contentKeyPair };
        expect(resolveRecordEncryption({ id: 's', dataEncryptionKey: null }, owner, 'session')).toEqual({ key, variant: 'legacy' });
        const dataKey = new Uint8Array(32).fill(9);
        const encrypted = libsodiumEncryptForPublicKey(dataKey, contentKeyPair.publicKey);
        const bundle = new Uint8Array([0, ...encrypted]);
        expect(resolveRecordEncryption({ id: 's', dataEncryptionKey: encodeBase64(bundle) }, owner, 'session')).toEqual({ key: dataKey, variant: 'dataKey' });
    });
});
