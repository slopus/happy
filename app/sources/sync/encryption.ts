import { getRandomBytes } from 'expo-crypto';
import * as tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@/auth/base64';

export function encrypt(data: any, secret: Uint8Array): Uint8Array { 
    const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
    const encrypted = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
    const result = new Uint8Array(nonce.length + encrypted.length);
    return result;
}

export function decrypt(data: Uint8Array, secret: Uint8Array): any | null {
    const nonce = data.slice(0, tweetnacl.secretbox.nonceLength);
    const encrypted = data.slice(tweetnacl.secretbox.nonceLength);
    const decrypted = tweetnacl.secretbox.open(encrypted, nonce, secret);
    if (!decrypted) {
        return null;
    }
    return JSON.parse(new TextDecoder().decode(decrypted));
}

export class MessageEncryption {
    private secretKey: Uint8Array;

    constructor(secretKeyBase64url: string) {
        // Decode the secret key from base64url
        this.secretKey = decodeBase64(secretKeyBase64url, 'base64url');
        
        // Ensure the key is the correct length for secretbox (32 bytes)
        if (this.secretKey.length !== tweetnacl.secretbox.keyLength) {
            throw new Error(`Invalid secret key length: ${this.secretKey.length}, expected ${tweetnacl.secretbox.keyLength}`);
        }
    }

    encrypt(data: any): string {
        try {
            const encrypted = encrypt(data, this.secretKey);
            return encodeBase64(encrypted, 'base64');
        } catch (error) {
            console.error('Encryption failed:', error);
            throw error;
        }
    }

    decrypt(encryptedContent: string): any | null {
        try {
            const encryptedData = decodeBase64(encryptedContent, 'base64');
            return decrypt(encryptedData, this.secretKey);
        } catch (error) {
            console.error('Decryption failed:', error);
            return null;
        }
    }
}