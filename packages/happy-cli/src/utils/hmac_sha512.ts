import { createHmac } from 'node:crypto'

/**
 * Compute HMAC-SHA512 for given key and data
 * @param key - The key for HMAC
 * @param data - The data to compute HMAC for
 * @returns HMAC-SHA512 result as Uint8Array
 */
export async function hmac_sha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const hmac = createHmac('sha512', key)
    hmac.update(data)
    return new Uint8Array(hmac.digest())
}