#!/usr/bin/env node

/**
 * Test script that EXACTLY replicates the web client's authentication flow
 * This simulates what happens in manual.tsx when a user enters a secret key
 */

import axios from 'axios';
import tweetnacl from 'tweetnacl';

const SERVER_URL = 'http://localhost:3005';

// The secret key from the e2e output (this is what the user is pasting in)
const SECRET_KEY = 'MI23B-PJ53Q-VHZHX-2QAN7-TOCOY-IGNSU-QYC65-TOYXU-GE6BT-7BEKV-OQ';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ==================== EXACT COPY FROM WEB CLIENT ====================

/**
 * base32ToBytes - exact copy from happy/sources/auth/secretKeyBackup.ts:35-74
 */
function base32ToBytes(base32) {
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

    const bytes = [];
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
 * parseBackupSecretKey - exact copy from happy/sources/auth/secretKeyBackup.ts:109-131
 */
function parseBackupSecretKey(formattedKey) {
    try {
        // Convert from base32 back to bytes
        const bytes = base32ToBytes(formattedKey);

        // Ensure we have exactly 32 bytes
        if (bytes.length !== 32) {
            throw new Error(`Invalid key length: expected 32 bytes, got ${bytes.length}`);
        }

        // Encode to base64url
        return Buffer.from(bytes).toString('base64url');
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
 * normalizeSecretKey - exact copy from happy/sources/auth/secretKeyBackup.ts:158-179
 */
function normalizeSecretKey(key) {
    // Trim whitespace
    const trimmed = key.trim();

    // Check if it looks like a formatted key (contains dashes or spaces between groups)
    // or has been typed with spaces/formatting
    if (/[-\s]/.test(trimmed) || trimmed.length > 50) {
        return parseBackupSecretKey(trimmed);
    }

    // Otherwise try to parse as base64url
    try {
        const bytes = Buffer.from(trimmed, 'base64url');
        if (bytes.length !== 32) {
            throw new Error('Invalid secret key');
        }
        return trimmed;
    } catch (error) {
        // If base64 parsing fails, try parsing as formatted key anyway
        return parseBackupSecretKey(trimmed);
    }
}

// ==================== AUTHENTICATION (similar to authGetToken) ====================

async function authGetToken(secretBytes) {
    // Derive keypair from secret (exactly like authChallenge.ts does)
    const keypair = tweetnacl.sign.keyPair.fromSeed(secretBytes);

    // Create challenge and signature (exactly like authGetToken.ts does)
    const challenge = tweetnacl.randomBytes(32);
    const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

    // Send to server
    const response = await axios.post(`${SERVER_URL}/v1/auth`, {
        challenge: Buffer.from(challenge).toString('base64'),
        signature: Buffer.from(signature).toString('base64'),
        publicKey: Buffer.from(keypair.publicKey).toString('base64')
    });

    return response.data.token;
}

// ==================== MAIN TEST ====================

console.log('=== Testing Web Client Exact Flow ===\n');

console.log('Step 1: User input');
console.log('  Secret key:', SECRET_KEY);

try {
    console.log('\nStep 2: normalizeSecretKey');
    const normalizedKey = normalizeSecretKey(SECRET_KEY);
    console.log('  ✓ Normalized to base64url:', normalizedKey.substring(0, 20) + '...');

    console.log('\nStep 3: Decode to bytes');
    const secretBytes = Buffer.from(normalizedKey, 'base64url');
    console.log('  ✓ Secret bytes length:', secretBytes.length);

    if (secretBytes.length !== 32) {
        throw new Error(`Invalid secret key length: expected 32 bytes, got ${secretBytes.length}`);
    }
    console.log('  ✓ Length validation passed');

    console.log('\nStep 4: Derive keypair');
    const keypair = tweetnacl.sign.keyPair.fromSeed(secretBytes);
    console.log('  ✓ Public key:', Buffer.from(keypair.publicKey).toString('base64').substring(0, 20) + '...');

    console.log('\nStep 5: Authenticate with server');
    const token = await authGetToken(secretBytes);
    console.log('  ✓ SUCCESS! Got token:', token.substring(0, 40) + '...');

    console.log('\n✅ All steps passed! The key should work in the web client.');

} catch (error) {
    console.log('\n❌ FAILED:', error.message);
    if (error.response) {
        console.log('  Server response:', error.response.data);
    }
    console.log('\nFull error:', error);
}
