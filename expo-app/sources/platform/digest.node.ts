/**
 * Platform adapter: message digest (node/vitest).
 */

export type DigestAlgorithm = 'SHA-256' | 'SHA-512';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('node:crypto') as any;

export async function digest(algorithm: DigestAlgorithm, data: Uint8Array): Promise<Uint8Array> {
    const algo = algorithm === 'SHA-256' ? 'sha256' : 'sha512';
    const buf = crypto.createHash(algo).update(Buffer.from(data)).digest();
    return new Uint8Array(buf);
}

