/**
 * Platform adapter: HMAC-SHA512 (node).
 *
 * Used by vitest (node environment).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('node:crypto') as any;

export async function hmacSha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const buf = crypto.createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest();
    return new Uint8Array(buf);
}

