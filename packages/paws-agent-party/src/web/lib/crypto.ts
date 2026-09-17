/**
 * Browser-side message crypto — a WebCrypto mirror of the package's message layer (src/core/crypto.ts). The party key
 * comes from the owner's registry (the server hands it to the owner on a self-hosted/local server); the server only
 * ever stores and relays ciphertext. Wire format: `base64url(iv[12] ‖ AES-256-GCM ciphertext)`.
 */

const fromB64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))

const toB64 = (bytes: Uint8Array): string => {
  let bin = ''
  for (const byte of bytes) {
    bin += String.fromCharCode(byte)
  }
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const importKey = (keyB64: string, usage: KeyUsage): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', fromB64(keyB64) as BufferSource, { name: 'AES-GCM' }, false, [usage])

/** Decrypt `base64url(iv ‖ ct)` → text, or `null` when the key is wrong/missing or the blob is tampered. */
export const decrypt = async (keyB64: string, blob: string): Promise<string | null> => {
  try {
    const packed = fromB64(blob)
    const key = await importKey(keyB64, 'decrypt')
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: packed.slice(0, 12) as BufferSource },
      key,
      packed.slice(12) as BufferSource,
    )
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

/** Encrypt UTF-8 text → `base64url(iv ‖ ct)`. */
export const encrypt = async (keyB64: string, text: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await importKey(keyB64, 'encrypt')
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text) as BufferSource),
  )
  const packed = new Uint8Array(12 + ct.length)
  packed.set(iv)
  packed.set(ct, 12)
  return toB64(packed)
}
