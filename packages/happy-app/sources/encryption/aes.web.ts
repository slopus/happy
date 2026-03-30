import { decodeBase64, encodeBase64 } from '@/encryption/base64';

async function importAESKey(key64: string): Promise<CryptoKey> {
    const raw = Uint8Array.from(atob(key64), c => c.charCodeAt(0));
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptAESGCMString(data: string, key64: string): Promise<string> {
    const key = await importAESKey(key64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(data);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return encodeBase64(combined);
}

export async function decryptAESGCMString(data: string, key64: string): Promise<string | null> {
    const key = await importAESKey(key64);
    const combined = decodeBase64(data);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
}

export async function encryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array> {
    const encrypted = await encryptAESGCMString(new TextDecoder().decode(data), key64);
    return decodeBase64(encrypted);
}

export async function decryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array | null> {
    const decrypted = await decryptAESGCMString(encodeBase64(data), key64);
    return decrypted ? new TextEncoder().encode(decrypted) : null;
}
