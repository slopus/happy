import sodium from '@/encryption/libsodium.lib';
import { encodeHex } from '@/encryption/hex';

/**
 * A short keyed hash of a provider account id, so analytics can tell one
 * account from another without learning its name. The key is derived from the
 * account secret, so the same account hashes the same on every device of one
 * user and differently for every other user.
 *
 * Keyed BLAKE2b-256 (libsodium `crypto_generichash` at its default length, which
 * every libsodium build accepts), first 12 lowercase hex characters.
 */
export function providerAccountHash(key: Uint8Array, providerId: string): string {
    const digest = sodium.crypto_generichash(32, new TextEncoder().encode(providerId), key);
    return encodeHex(digest).slice(0, 12).toLowerCase();
}
