import { deriveKey } from '@/encryption/deriveKey';
import { encryptSecretBox, decryptSecretBox } from '@/encryption/libsodium';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';

/**
 * Encrypt a data encryption key for public sharing using a token
 *
 * @param dataEncryptionKey - The session's data encryption key to encrypt
 * @param token - The random public share token
 * @returns Base64 encoded encrypted data key
 *
 * @remarks
 * Uses SecretBox encryption with a key derived from the token.
 * The token must be kept secret as it enables decryption.
 */
export async function encryptDataKeyForPublicShare(
    dataEncryptionKey: Uint8Array,
    token: string
): Promise<string> {
    // Derive encryption key from token
    const tokenBytes = new TextEncoder().encode(token);
    const encryptionKey = await deriveKey(tokenBytes, 'Happy Public Share', ['v1']);

    // IMPORTANT: encryptSecretBox JSON-stringifies its input, so we must not pass Uint8Array directly.
    const payload = {
        v: 0,
        keyB64: encodeBase64(dataEncryptionKey, 'base64'),
    };
    const encrypted = encryptSecretBox(payload, encryptionKey);

    // Return as base64
    return encodeBase64(encrypted, 'base64');
}

/**
 * Decrypt a data encryption key from a public share using a token
 *
 * @param encryptedDataKey - The encrypted data key (base64)
 * @param token - The public share token
 * @returns Decrypted data encryption key, or null if decryption fails
 *
 * @remarks
 * This is the inverse of encryptDataKeyForPublicShare.
 */
export async function decryptDataKeyFromPublicShare(
    encryptedDataKey: string,
    token: string
): Promise<Uint8Array | null> {
    try {
        // Derive decryption key from token
        const tokenBytes = new TextEncoder().encode(token);
        const decryptionKey = await deriveKey(tokenBytes, 'Happy Public Share', ['v1']);

        // Decode from base64
        const encrypted = decodeBase64(encryptedDataKey, 'base64');

        const payload = decryptSecretBox(encrypted, decryptionKey) as { v: number; keyB64: string } | null;
        if (!payload || payload.v !== 0) {
            return null;
        }
        if (typeof payload.keyB64 !== 'string') {
            return null;
        }
        return decodeBase64(payload.keyB64, 'base64');
    } catch (error) {
        return null;
    }
}
