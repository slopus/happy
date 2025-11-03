import axios from 'axios';
import tweetnacl from 'tweetnacl';

const SERVER_URL = 'http://localhost:3005';
const SECRET_KEY = 'RX76Y-KNLWX-D4JUD-NJ24N-ZIUB2-34XBU-DZNV7-MFZIV-FBP42-ZL5NN-CA';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToBytes(base32) {
    const cleaned = base32.toUpperCase()
        .replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/9/g, 'G')
        .replace(/[^A-Z2-7]/g, '');
    
    const bytes = [];
    let buffer = 0, bufferLength = 0;

    for (const char of cleaned) {
        const value = BASE32_ALPHABET.indexOf(char);
        buffer = (buffer << 5) | value;
        bufferLength += 5;
        if (bufferLength >= 8) {
            bufferLength -= 8;
            bytes.push((buffer >> bufferLength) & 0xff);
        }
    }
    return new Uint8Array(bytes);
}

console.log('Testing key:', SECRET_KEY);
const secretBytes = base32ToBytes(SECRET_KEY);
console.log('Bytes length:', secretBytes.length);

const keypair = tweetnacl.sign.keyPair.fromSeed(secretBytes);
const challenge = tweetnacl.randomBytes(32);
const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

try {
    const response = await axios.post(`${SERVER_URL}/v1/auth`, {
        challenge: Buffer.from(challenge).toString('base64'),
        signature: Buffer.from(signature).toString('base64'),
        publicKey: Buffer.from(keypair.publicKey).toString('base64')
    });
    console.log('✓ SUCCESS! Token:', response.data.token.substring(0, 40) + '...');
} catch (error) {
    console.log('✗ FAILED:', error.response?.data?.message || error.message);
    console.log('Full error:', JSON.stringify(error.response?.data, null, 2));
}
