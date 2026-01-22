/**
 * Backup key formatting utilities
 * Formats secret keys in the same way as the mobile client for compatibility
 */

// Base32 alphabet (RFC 4648) - excludes confusing characters
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function bytesToBase32(bytes: Uint8Array): string {
    let result = '';
    let buffer = 0;
    let bufferLength = 0;

    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bufferLength += 8;

        while (bufferLength >= 5) {
            bufferLength -= 5;
            result += BASE32_ALPHABET[(buffer >> bufferLength) & 0x1f];
        }
    }

    // Handle remaining bits
    if (bufferLength > 0) {
        result += BASE32_ALPHABET[(buffer << (5 - bufferLength)) & 0x1f];
    }

    return result;
}

/**
 * Formats a secret key for display in a user-friendly format matching mobile client
 * @param secretBytes - 32-byte secret key as Uint8Array
 * @returns Formatted string like "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
 */
export function formatSecretKeyForBackup(secretBytes: Uint8Array): string {
    // Convert to base32
    const base32 = bytesToBase32(secretBytes);

    // Split into groups of 5 characters
    const groups: string[] = [];
    for (let i = 0; i < base32.length; i += 5) {
        groups.push(base32.slice(i, i + 5));
    }

    // Join with dashes
    // 32 bytes = 256 bits = 52 base32 chars (51.2 rounded up)
    // That's approximately 11 groups of 5 chars
    return groups.join('-');
}