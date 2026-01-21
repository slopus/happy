/**
 * Platform adapter: UUID v4 (node/vitest).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('node:crypto') as any;

export function randomUUID(): string {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Extremely old node fallback: generate via random bytes.
    const bytes = crypto.randomBytes(16) as Buffer;
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

