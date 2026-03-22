/**
 * Encryption utilities for happy-sync.
 *
 * Two variants:
 * - Legacy: TweetNaCl secretbox (shared secret)
 * - DataKey: AES-256-GCM (modern, preferred)
 *
 * Both encrypt JSON payloads to Uint8Array and back.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';

// ─── Base64 utilities ────────────────────────────────────────────────────────

export function encodeBase64(buffer: Uint8Array): string {
    return Buffer.from(buffer).toString('base64');
}

export function decodeBase64(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, 'base64'));
}

export function encodeBase64Url(buffer: Uint8Array): string {
    return Buffer.from(buffer)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}

export function decodeBase64Url(base64url: string): Uint8Array {
    const base64 = base64url
        .replaceAll('-', '+')
        .replaceAll('_', '/')
        + '='.repeat((4 - base64url.length % 4) % 4);
    return new Uint8Array(Buffer.from(base64, 'base64'));
}

// ─── Random bytes ────────────────────────────────────────────────────────────

export function getRandomBytes(size: number): Uint8Array {
    return new Uint8Array(randomBytes(size));
}

// ─── Key derivation ──────────────────────────────────────────────────────────

export function libsodiumPublicKeyFromSecretKey(seed: Uint8Array): Uint8Array {
    const hashedSeed = new Uint8Array(createHash('sha512').update(seed).digest());
    const secretKey = hashedSeed.slice(0, 32);
    return new Uint8Array(tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey);
}

export function libsodiumEncryptForPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeralKeyPair = tweetnacl.box.keyPair();
    const nonce = getRandomBytes(tweetnacl.box.nonceLength);
    const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);
    const result = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
    result.set(ephemeralKeyPair.publicKey, 0);
    result.set(nonce, ephemeralKeyPair.publicKey.length);
    result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
    return result;
}

// ─── Auth challenge ──────────────────────────────────────────────────────────

export function authChallenge(secret: Uint8Array): {
    challenge: Uint8Array;
    publicKey: Uint8Array;
    signature: Uint8Array;
} {
    const keypair = tweetnacl.sign.keyPair.fromSeed(secret);
    const challenge = getRandomBytes(32);
    const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);
    return { challenge, publicKey: keypair.publicKey, signature };
}

// ─── Legacy encryption (TweetNaCl secretbox) ─────────────────────────────────

export function encryptLegacy(data: unknown, secret: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
    const encrypted = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}

export function decryptLegacy(data: Uint8Array, secret: Uint8Array): unknown | null {
    const nonce = data.slice(0, tweetnacl.secretbox.nonceLength);
    const encrypted = data.slice(tweetnacl.secretbox.nonceLength);
    const decrypted = tweetnacl.secretbox.open(encrypted, nonce, secret);
    if (!decrypted) return null;
    return JSON.parse(new TextDecoder().decode(decrypted));
}

// ─── DataKey encryption (AES-256-GCM) ────────────────────────────────────────

export function encryptWithDataKey(data: unknown, dataKey: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Bundle: version(1) + nonce(12) + ciphertext + authTag(16)
    const bundle = new Uint8Array(1 + 12 + encrypted.length + 16);
    bundle.set([0], 0);
    bundle.set(nonce, 1);
    bundle.set(new Uint8Array(encrypted), 13);
    bundle.set(new Uint8Array(authTag), 13 + encrypted.length);
    return bundle;
}

export function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): unknown | null {
    if (bundle.length < 1 + 12 + 16) return null;
    if (bundle[0] !== 0) return null;

    const nonce = bundle.slice(1, 13);
    const authTag = bundle.slice(bundle.length - 16);
    const ciphertext = bundle.slice(13, bundle.length - 16);

    try {
        const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

// ─── Generic encrypt/decrypt routing ─────────────────────────────────────────

export type EncryptionVariant = 'legacy' | 'dataKey';

export function encrypt(key: Uint8Array, variant: EncryptionVariant, data: unknown): Uint8Array {
    return variant === 'legacy' ? encryptLegacy(data, key) : encryptWithDataKey(data, key);
}

export function decrypt(key: Uint8Array, variant: EncryptionVariant, data: Uint8Array): unknown | null {
    return variant === 'legacy' ? decryptLegacy(data, key) : decryptWithDataKey(data, key);
}

// ─── Key material for SyncNode ───────────────────────────────────────────────

export interface KeyMaterial {
    key: Uint8Array;
    variant: EncryptionVariant;
}

export function encryptMessage(keyMaterial: KeyMaterial, data: unknown): string {
    const encrypted = encrypt(keyMaterial.key, keyMaterial.variant, data);
    return encodeBase64(encrypted);
}

export function decryptMessage(keyMaterial: KeyMaterial, ciphertext: string): unknown | null {
    const data = decodeBase64(ciphertext);
    return decrypt(keyMaterial.key, keyMaterial.variant, data);
}
