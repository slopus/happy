import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto'
import { webcrypto } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/**
 * All crypto of the system, zero dependencies. Two layers:
 *
 * 1. **Message encryption** — AES-256-GCM with the party's own random key. Every message body is stored and relayed as
 *    `base64url(iv ‖ ciphertext)`; the key travels only inside the ref fragment (`#k=…`) and never reaches a server.
 * 2. **Key wrapping** (password-manager style) — the user's master password derives an X25519 key pair via PBKDF2 (the
 *    KDF; PBKDF2 because browsers can reproduce it with WebCrypto). The PUBLIC key seals party keys: `seal()` needs no
 *    secrets, so any CLI/agent can wrap a fresh party key for the owner's cabinet. Only the PRIVATE key — which exists
 *    solely while the master password is entered, and is never stored — can `unseal()` them back.
 *
 * Wire formats (the site's browser client mirrors them with WebCrypto; pinned by fixed vectors in crypto.test.ts):
 *
 * - party key: 32 random bytes, base64url
 * - message blob: base64url(iv[12] ‖ gcm-ciphertext)
 * - master KDF: PBKDF2-SHA256, 600 000 iterations, 16-byte salt → 32-byte X25519 seed (= the private key)
 * - keys: X25519, raw 32 bytes base64url (public), seed 32 bytes base64url (private)
 * - sealed blob: base64url(ephemeralPub[32] ‖ iv[12] ‖ gcm-ciphertext), AES key = HKDF-SHA256(dh, salt = empty, info =
 *   "agents-party-seal-v1" ‖ ephPub ‖ recipientPub, 32 bytes)
 *
 * WebCrypto recipe for the browser side: PBKDF2 via subtle.deriveBits; X25519 private key import via `pkcs8` (prefix
 * the 32-byte seed with X25519_PKCS8_PREFIX below), public key export via `exportKey('jwk').x` (already base64url) or
 * `raw`; DH via subtle.deriveBits({ name: 'X25519', public }); HKDF and AES-GCM as usual. Browser floor for native
 * X25519: Chrome 133+ / Safari 17+ / Firefox 132+ — below that, ship a tiny x25519 implementation. The message layer in
 * this file is runtime-agnostic on purpose (btoa/atob + WebCrypto only, no Buffer).
 */

const IV_BYTES = 12
const GCM_TAG_BYTES = 16
const KDF_ITERATIONS = 600_000
const SEAL_INFO = 'agents-party-seal-v1'

const toB64 = (bytes: Uint8Array): string => {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const fromB64 = (text: string): Uint8Array => {
  const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  return Uint8Array.from(bin, (char) => char.charCodeAt(0))
}

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16))

// ── Message encryption ───────────────────────────────────────────────────────

/** A fresh random 256-bit party key, base64url — goes into the ref's `#k=` fragment. */
export const generatePartyKey = (): string => toB64(webcrypto.getRandomValues(new Uint8Array(32)))

const importAesKey = async (key: string): Promise<webcrypto.CryptoKey> => {
  const bytes = fromB64(key)
  if (bytes.length !== 32) throw new Error('Invalid party key: expected 32 bytes base64url')
  return webcrypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Encrypt UTF-8 text → base64url(iv ‖ ciphertext). */
export const encryptText = async (key: string, plaintext: string): Promise<string> => {
  const aesKey = await importAesKey(key)
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plaintext))
  const packed = new Uint8Array(IV_BYTES + ct.byteLength)
  packed.set(iv, 0)
  packed.set(new Uint8Array(ct), IV_BYTES)
  return toB64(packed)
}

/**
 * Decrypt base64url(iv ‖ ciphertext) → text, or `null` when the key is wrong or the blob is tampered — GCM's auth tag
 * doubles as the "is this the right key" check, so nothing key-derived is ever stored.
 */
export const decryptText = async (key: string, blob: string): Promise<string | null> => {
  try {
    const packed = fromB64(blob)
    if (packed.length <= IV_BYTES) return null
    const aesKey = await importAesKey(key)
    const pt = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: packed.slice(0, IV_BYTES) },
      aesKey,
      packed.slice(IV_BYTES),
    )
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

/**
 * Does this even have the SHAPE of a message body — base64url of at least `iv[12] ‖ gcm-tag[16]`? A server can't read a
 * message, but it can refuse to store something that provably isn't one: a client that skipped the encryption step
 * would otherwise fill a party with bodies every other participant sees as `undecrypted: true`.
 *
 * It is a broken-client check and nothing more — random base64url of the right length passes, so it stops neither spam
 * nor a hostile writer. Only the party key can tell a real message from noise (that's what GCM's tag is for).
 */
export const looksLikeCiphertext = (blob: string): boolean =>
  /^[A-Za-z0-9_-]+$/.test(blob) && Math.floor((blob.length * 3) / 4) >= IV_BYTES + GCM_TAG_BYTES

// ── Master key pair + sealing ────────────────────────────────────────────────

// Raw X25519 keys wrapped into the DER structures node:crypto expects (fixed prefixes from RFC 8410).
export const X25519_PKCS8_PREFIX = hexToBytes('302e020100300506032b656e04220420')
const X25519_SPKI_PREFIX = hexToBytes('302a300506032b656e032100')

const privateKeyFromSeed = (seed: Uint8Array): KeyObject =>
  createPrivateKey({ key: concatBytes(X25519_PKCS8_PREFIX, seed) as Buffer, format: 'der', type: 'pkcs8' })

const publicKeyFromRaw = (raw: Uint8Array): KeyObject =>
  createPublicKey({ key: concatBytes(X25519_SPKI_PREFIX, raw) as Buffer, format: 'der', type: 'spki' })

const rawPublicKey = (key: KeyObject): Uint8Array =>
  new Uint8Array(key.export({ format: 'der', type: 'spki' }).subarray(X25519_SPKI_PREFIX.length))

export interface MasterKeyPair {
  /** Not a secret: stored in the account / local config; can only seal. */
  publicKey: string
  /** Exists only while the master password is entered; never stored anywhere. Can unseal. */
  privateKey: string
}

/** A fresh random salt for the master KDF — generated once per user, stored openly next to the public key. */
export const generateMasterSalt = (): string => toB64(webcrypto.getRandomValues(new Uint8Array(16)))

/** Master password + salt → deterministic X25519 key pair (PBKDF2-SHA256, 600k iterations — slow on purpose). */
export const deriveMasterKeyPair = async (masterPassword: string, salt: string): Promise<MasterKeyPair> => {
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(masterPassword), 'PBKDF2', false, [
    'deriveBits',
  ])
  const seed = new Uint8Array(
    await webcrypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations: KDF_ITERATIONS },
      material,
      256,
    ),
  )
  const privateKey = privateKeyFromSeed(seed)
  return { publicKey: toB64(rawPublicKey(createPublicKey(privateKey))), privateKey: toB64(seed) }
}

const sealAesKey = (shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array => {
  const info = concatBytes(new TextEncoder().encode(SEAL_INFO), ephPub, recipientPub)
  return new Uint8Array(hkdfSync('sha256', shared, new Uint8Array(0), info, 32))
}

/** Seal a secret (e.g. a party key) with a public key — no secrets needed, anyone can do this. */
export const seal = async (publicKey: string, secret: string): Promise<string> => {
  const recipientPubRaw = fromB64(publicKey)
  const eph = generateKeyPairSync('x25519')
  const ephPubRaw = rawPublicKey(eph.publicKey)
  const shared = new Uint8Array(
    diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyFromRaw(recipientPubRaw) }),
  )
  const aesRaw = sealAesKey(shared, ephPubRaw, recipientPubRaw)
  const blob = fromB64(await encryptText(toB64(aesRaw), secret))
  return toB64(concatBytes(ephPubRaw, blob))
}

/** Unseal with the private key (derived from the master password). `null` on wrong key or tampering. */
export const unseal = async (privateKey: string, sealedBlob: string): Promise<string | null> => {
  try {
    const packed = fromB64(sealedBlob)
    if (packed.length <= 32 + IV_BYTES) return null
    const ephPubRaw = packed.slice(0, 32)
    const priv = privateKeyFromSeed(fromB64(privateKey))
    const recipientPubRaw = rawPublicKey(createPublicKey(priv))
    const shared = new Uint8Array(diffieHellman({ privateKey: priv, publicKey: publicKeyFromRaw(ephPubRaw) }))
    const aesRaw = sealAesKey(shared, ephPubRaw, recipientPubRaw)
    return await decryptText(toB64(aesRaw), toB64(packed.slice(32)))
  } catch {
    return null
  }
}
