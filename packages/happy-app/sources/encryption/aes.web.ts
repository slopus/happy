/**
 * AES-GCM encryption — web implementation via crypto.subtle.
 *
 * Wire-format mirrors what the native `rn-encryption` module emits on iOS
 * (`AES.GCM.seal` produces nonce(12) + ciphertext + tag(16)) and on Android
 * (same Cryptokit-equivalent layout), so a blob encrypted on one platform
 * can be decrypted on another. Output is base64. Keys are 32-byte AES-256
 * passed as base64 strings.
 *
 * `rn-encryption` does already ship a web fallback through
 * `web-secure-encryption`, so going through it on the web works today.
 * Implementing this file directly against crypto.subtle drops the
 * dependency hop on the web bundle and lets Metro resolve a cheaper
 * platform-specific module without a runtime Platform.OS check.
 *
 * NOTE: encryptAESGCM / decryptAESGCM use `decodeUTF8`/`encodeUTF8` to keep
 * binary contract parity with aes.ts. The roundtrip-only property still
 * matches that file (see the comment in encryptor.ts about the
 * UTF-8-via-Uint8Array quirk in the legacy AES path).
 */
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decodeUTF8, encodeUTF8 } from './text';

const ALGO = 'AES-GCM';
const IV_LEN = 12;

async function importKey(key64: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
    const keyBytes = decodeBase64(key64);
    return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: ALGO }, false, [usage]);
}

function concat(iv: Uint8Array, ciphertextWithTag: ArrayBuffer): Uint8Array {
    const out = new Uint8Array(iv.length + ciphertextWithTag.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ciphertextWithTag), iv.length);
    return out;
}

function split(bundle: Uint8Array): { iv: Uint8Array; ciphertext: Uint8Array } {
    return { iv: bundle.slice(0, IV_LEN), ciphertext: bundle.slice(IV_LEN) };
}

export async function encryptAESGCMString(data: string, key64: string): Promise<string> {
    const key = await importKey(key64, 'encrypt');
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ciphertext = await crypto.subtle.encrypt(
        { name: ALGO, iv: iv as BufferSource },
        key,
        new TextEncoder().encode(data) as BufferSource,
    );
    return encodeBase64(concat(iv, ciphertext));
}

export async function decryptAESGCMString(data: string, key64: string): Promise<string | null> {
    try {
        const key = await importKey(key64, 'decrypt');
        const { iv, ciphertext } = split(decodeBase64(data));
        const plaintext = await crypto.subtle.decrypt(
            { name: ALGO, iv: iv as BufferSource },
            key,
            ciphertext as BufferSource,
        );
        return new TextDecoder().decode(plaintext);
    } catch {
        return null;
    }
}

export async function encryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array> {
    // Mirror aes.ts: the existing AES path round-trips bytes-as-UTF-8-strings.
    // Going around that here would diverge the web wire from the native one.
    const encryptedB64 = (await encryptAESGCMString(decodeUTF8(data), key64)).trim();
    return decodeBase64(encryptedB64);
}

export async function decryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array | null> {
    const result = await decryptAESGCMString(encodeBase64(data), key64);
    return result ? encodeUTF8(result) : null;
}
