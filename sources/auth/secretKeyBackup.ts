import { encodeBase64, decodeBase64 } from '@/auth/base64';

/**
 * Converts a 32-byte secret key to a user-readable format similar to 1Password
 * Format: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
 * Uses base32 encoding without padding for better readability
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

function base32ToBytes(base32: string): Uint8Array {
    // Normalize the input:
    // 1. Convert to uppercase
    // 2. Replace common mistakes: 0->O, 1->I, 8->B
    // 3. Remove all non-base32 characters (spaces, dashes, etc)
    let normalized = base32.toUpperCase()
        .replace(/0/g, 'O')  // Zero to O
        .replace(/1/g, 'I')  // One to I  
        .replace(/8/g, 'B')  // Eight to B
        .replace(/9/g, 'G'); // Nine to G (arbitrary but consistent)
    
    // Remove any non-base32 characters
    const cleaned = normalized.replace(/[^A-Z2-7]/g, '');
    
    // Check if we have any content left
    if (cleaned.length === 0) {
        throw new Error('No valid characters found');
    }
    
    const bytes: number[] = [];
    let buffer = 0;
    let bufferLength = 0;

    for (const char of cleaned) {
        const value = BASE32_ALPHABET.indexOf(char);
        if (value === -1) {
            throw new Error('Invalid base32 character');
        }

        buffer = (buffer << 5) | value;
        bufferLength += 5;

        if (bufferLength >= 8) {
            bufferLength -= 8;
            bytes.push((buffer >> bufferLength) & 0xff);
        }
    }

    return new Uint8Array(bytes);
}

/**
 * Formats a secret key for display in a user-friendly format
 * @param secretKey - Base64url encoded 32-byte secret key
 * @returns Formatted string like "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
 */
export function formatSecretKeyForBackup(secretKey: string): string {
    try {
        // Decode from base64url to bytes
        const bytes = decodeBase64(secretKey, 'base64url');

        // Convert to base32
        const base32 = bytesToBase32(bytes);

        // Split into groups of 5 characters
        const groups: string[] = [];
        for (let i = 0; i < base32.length; i += 5) {
            groups.push(base32.slice(i, i + 5));
        }

        // Join with dashes (need all groups to preserve all 32 bytes)
        // 32 bytes = 256 bits = 52 base32 chars (51.2 rounded up)
        // That's 11 groups of 5 chars (55 chars total)
        return groups.join('-');
    } catch (error) {
        throw new Error('Invalid secret key format');
    }
}

/**
 * Parses a user-friendly formatted secret key back to base64url
 * @param formattedKey - Formatted string like "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
 * @returns Base64url encoded secret key
 */
export function parseBackupSecretKey(formattedKey: string): string {
    try {
        // Convert from base32 back to bytes
        const bytes = base32ToBytes(formattedKey);

        // Ensure we have exactly 32 bytes
        if (bytes.length !== 32) {
            throw new Error(`Invalid key length: expected 32 bytes, got ${bytes.length}`);
        }

        // Encode to base64url
        return encodeBase64(bytes, 'base64url');
    } catch (error) {
        // Re-throw specific error messages
        if (error instanceof Error) {
            if (error.message.includes('Invalid key length') || 
                error.message.includes('No valid characters found')) {
                throw error;
            }
        }
        throw new Error('Invalid secret key format');
    }
}

/**
 * Validates if a string is a properly formatted secret key
 * @param key - The key to validate (either base64url or formatted)
 * @returns true if valid, false otherwise
 */
export function isValidSecretKey(key: string): boolean {
    try {
        // Try parsing as formatted key first
        if (key.includes('-')) {
            const parsed = parseBackupSecretKey(key);
            return decodeBase64(parsed, 'base64url').length === 32;
        }

        // Try as base64url
        return decodeBase64(key, 'base64url').length === 32;
    } catch {
        return false;
    }
}

/**
 * Normalizes a secret key to base64url format
 * @param key - The key in either format
 * @returns Base64url encoded secret key
 */
export function normalizeSecretKey(key: string): string {
    // Trim whitespace
    const trimmed = key.trim();
    
    // Check if it looks like a formatted key (contains dashes or spaces between groups)
    // or has been typed with spaces/formatting
    if (/[-\s]/.test(trimmed) || trimmed.length > 50) {
        return parseBackupSecretKey(trimmed);
    }

    // Otherwise try to parse as base64url
    try {
        const bytes = decodeBase64(trimmed, 'base64url');
        if (bytes.length !== 32) {
            throw new Error('Invalid secret key');
        }
        return trimmed;
    } catch (error) {
        // If base64 parsing fails, try parsing as formatted key anyway
        return parseBackupSecretKey(trimmed);
    }
}