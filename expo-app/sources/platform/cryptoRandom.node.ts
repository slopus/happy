/**
 * Platform adapter: cryptographically-secure random bytes (node).
 *
 * Used by vitest (node environment).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('node:crypto') as any;

export function getRandomBytes(length: number): Uint8Array {
    return new Uint8Array(crypto.randomBytes(length));
}

export async function getRandomBytesAsync(length: number): Promise<Uint8Array> {
    return getRandomBytes(length);
}

