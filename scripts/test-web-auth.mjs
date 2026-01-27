import axios from 'axios';
import tweetnacl from 'tweetnacl';

const SERVER_URL = 'http://localhost:3005';

// The secret key from the e2e output
const SECRET_KEY_FORMATTED = 'MI23B-PJ53Q-VHZHX-2QAN7-TOCOY-IGNSU-QYC65-TOYXU-GE6BT-7BEKV-OQ';

// Base32 alphabet
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToBytes(base32) {
    // Normalize and clean
    const cleaned = base32.toUpperCase()
        .replace(/0/g, 'O')
        .replace(/1/g, 'I')
        .replace(/8/g, 'B')
        .replace(/9/g, 'G')
        .replace(/[^A-Z2-7]/g, '');
    
    const bytes = [];
    let buffer = 0;
    let bufferLength = 0;

    for (const char of cleaned) {
        const value = BASE32_ALPHABET.indexOf(char);
        if (value === -1) {
            throw new Error('Invalid base32 character: ' + char);
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

// Step 1: Parse the formatted key
console.log('Step 1: Parsing formatted key...');
const secretBytes = base32ToBytes(SECRET_KEY_FORMATTED);
console.log('  Secret bytes length:', secretBytes.length);
console.log('  First few bytes:', Array.from(secretBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));

// Step 2: Derive keypair from secret (what authChallenge does)
console.log('\nStep 2: Deriving keypair from secret...');
const keypair = tweetnacl.sign.keyPair.fromSeed(secretBytes);
console.log('  Public key:', Buffer.from(keypair.publicKey).toString('base64').substring(0, 20) + '...');

// Step 3: Create challenge and signature (what authGetToken does)
console.log('\nStep 3: Creating auth challenge...');
const challenge = tweetnacl.randomBytes(32);
const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

// Step 4: Send to server
console.log('\nStep 4: Authenticating with server...');
try {
    const response = await axios.post(`${SERVER_URL}/v1/auth`, {
        challenge: Buffer.from(challenge).toString('base64'),
        signature: Buffer.from(signature).toString('base64'),
        publicKey: Buffer.from(keypair.publicKey).toString('base64')
    });
    console.log('  ✓ SUCCESS! Got token:', response.data.token.substring(0, 30) + '...');
} catch (error) {
    console.log('  ✗ FAILED:', error.response?.data || error.message);
}
