import { webcrypto } from 'node:crypto';
import { nextRandom } from './random.mjs';

export const CryptoDigestAlgorithm = { SHA256: 'SHA-256', SHA512: 'SHA-512' };

export async function digest(algorithm, data) {
    return webcrypto.subtle.digest(algorithm, data);
}

export function getRandomBytes(size) {
    return nextRandom(size);
}

export async function getRandomBytesAsync(size) {
    return nextRandom(size);
}
