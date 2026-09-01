import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    capabilityExpiry,
    hashShareManagementToken,
    isValidShareOwnership,
    readShareCapabilityAuthorization,
    verifyShareManagementToken,
} from './publicSessionShareCapability';

describe('public session share capabilities', () => {
    it('accepts only a 256-bit base64url token in the PawsShare authorization scheme', () => {
        const token = randomBytes(32).toString('base64url');

        expect(readShareCapabilityAuthorization(`PawsShare ${token}`)).toBe(token);
        expect(readShareCapabilityAuthorization(`Bearer ${token}`)).toBeNull();
        expect(readShareCapabilityAuthorization('PawsShare too-short')).toBeNull();
        expect(readShareCapabilityAuthorization(['PawsShare duplicate'])).toBeNull();
    });

    it('hashes tokens and verifies only an exact token without throwing on malformed input', () => {
        const token = randomBytes(32).toString('base64url');
        const hash = hashShareManagementToken(token);

        expect(hash).toHaveLength(32);
        expect(hash.equals(Buffer.from('39b61cf2c287ecf41cb98af4e6ba5a9bd2bb8732258d841717c9d5428d305b38', 'hex'))).toBe(false);
        expect(verifyShareManagementToken(token, hash)).toBe(true);
        expect(verifyShareManagementToken(randomBytes(32).toString('base64url'), hash)).toBe(false);
        expect(verifyShareManagementToken('not-a-token', hash)).toBe(false);
        expect(verifyShareManagementToken(token, Buffer.alloc(31))).toBe(false);
    });

    it('expires anonymous shares exactly 90 days after creation', () => {
        expect(capabilityExpiry(new Date('2026-09-01T00:00:00.000Z')).toISOString())
            .toBe('2026-11-30T00:00:00.000Z');
    });

    it('allows exactly one ownership mode', () => {
        const managementTokenHash = Buffer.alloc(32, 1);

        expect(isValidShareOwnership({ accountId: 'account-1', sessionId: 'session-1', managementTokenHash: null })).toBe(true);
        expect(isValidShareOwnership({ accountId: null, sessionId: null, managementTokenHash })).toBe(true);
        expect(isValidShareOwnership({ accountId: null, sessionId: null, managementTokenHash: null })).toBe(false);
        expect(isValidShareOwnership({ accountId: 'account-1', sessionId: 'session-1', managementTokenHash })).toBe(false);
        expect(isValidShareOwnership({ accountId: 'account-1', sessionId: null, managementTokenHash: null })).toBe(false);
    });
});
