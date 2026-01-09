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

    // Encrypt the data key
    const encrypted = encryptSecretBox(dataEncryptionKey, encryptionKey);

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

        // Decrypt and return
        const decrypted = decryptSecretBox(encrypted, decryptionKey);
        if (!decrypted) {
            return null;
        }

        // Convert back to Uint8Array if it's a different type
        if (typeof decrypted === 'string') {
            return new TextEncoder().encode(decrypted);
        }

        return new Uint8Array(decrypted);
    } catch (error) {
        console.error('Failed to decrypt public share data key:', error);
        return null;
    }
}
