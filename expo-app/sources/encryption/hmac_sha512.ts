import { hmacSha512 } from '@/platform/hmacSha512';

/**
 * Compatibility export used by `sources/encryption/deriveKey.ts`.
 *
 * NOTE: Avoid static imports of platform-only crypto (expo-crypto) here.
 * We use platform adapters with `.native/.web/.node` implementations.
 */
export async function hmac_sha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    return await hmacSha512(key, data);
}