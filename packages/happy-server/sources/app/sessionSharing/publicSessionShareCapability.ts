import * as crypto from 'node:crypto';

const MANAGEMENT_TOKEN_BYTES = 32;
const MANAGEMENT_TOKEN_LENGTH = 43;
const CAPABILITY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export type ShareOwnership = {
    accountId: string | null;
    sessionId: string | null;
    managementTokenHash: Uint8Array | null;
};

export function readShareCapabilityAuthorization(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const match = /^PawsShare ([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match) return null;
    const token = match[1];
    const decoded = Buffer.from(token, 'base64url');
    return decoded.length === MANAGEMENT_TOKEN_BYTES && token.length === MANAGEMENT_TOKEN_LENGTH ? token : null;
}

export function hashShareManagementToken(token: string): Buffer {
    return crypto.createHash('sha256').update(token, 'utf8').digest();
}

export function verifyShareManagementToken(token: string, storedHash: Uint8Array): boolean {
    if (!readShareCapabilityAuthorization(`PawsShare ${token}`)) return false;
    const actualHash = hashShareManagementToken(token);
    const expectedHash = Buffer.from(storedHash);
    if (actualHash.length !== expectedHash.length) return false;
    return crypto.timingSafeEqual(actualHash, expectedHash);
}

export function capabilityExpiry(now = new Date()): Date {
    return new Date(now.getTime() + CAPABILITY_LIFETIME_MS);
}

export function isValidShareOwnership(value: ShareOwnership): boolean {
    const accountOwned = Boolean(value.accountId && value.sessionId && !value.managementTokenHash);
    const capabilityOwned = Boolean(!value.accountId && !value.sessionId && value.managementTokenHash);
    return accountOwned !== capabilityOwned;
}
