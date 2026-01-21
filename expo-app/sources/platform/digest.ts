/**
 * Platform adapter: message digest.
 *
 * Strategy:
 * - App runtime (native + web): use `expo-crypto` (Expo provides a web implementation internally).
 * - Tests (vitest/node): alias `@/platform/digest` to `digest.node.ts`.
 */

import * as Crypto from 'expo-crypto';

export type DigestAlgorithm = 'SHA-256' | 'SHA-512';

export async function digest(algorithm: DigestAlgorithm, data: Uint8Array): Promise<Uint8Array> {
    const expoAlgo =
        algorithm === 'SHA-256'
            ? Crypto.CryptoDigestAlgorithm.SHA256
            : Crypto.CryptoDigestAlgorithm.SHA512;
    // `expo-crypto` expects `BufferSource` (ArrayBuffer-backed views). Some TS libs model `Uint8Array`
    // as possibly backed by `SharedArrayBuffer`, so copy to a plain `ArrayBuffer`-backed view.
    const safeData = new Uint8Array(data);
    const out = await Crypto.digest(expoAlgo, safeData);
    return new Uint8Array(out);
}

