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
    // Remove any non-base32 characters (like dashes)
    const cleaned = base32.replace(/[^A-Z2-7]/g, '');
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

        // Join with dashes (take first 7 groups for a cleaner look)
        return groups.slice(0, 7).join('-');
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
    if (key.includes('-')) {
        return parseBackupSecretKey(key);
    }

    // Validate it's a proper base64url key
    const bytes = decodeBase64(key, 'base64url');
    if (bytes.length !== 32) {
        throw new Error('Invalid secret key');
    }

    return key;
}