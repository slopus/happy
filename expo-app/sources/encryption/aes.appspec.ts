import { describe, it, expect } from '@/dev/testRunner';
import { decryptAESGCM, decryptAESGCMString, encryptAESGCM, encryptAESGCMString } from './aes';
import { getRandomBytes } from 'expo-crypto';
import { encodeBase64 } from '@/encryption/base64';

describe('AES Tests', () => {
    it('should encrypt and decrypt a string', async () => {
        const key = encodeBase64(getRandomBytes(32));
        const encrypted = await encryptAESGCMString(JSON.stringify('Hello, World!'), key);
        expect(typeof encrypted).toEqual('string');
        console.log(`Encrypted: ${encrypted}`);
        const decrypted = await decryptAESGCMString(encrypted, key);
        expect(typeof decrypted).toEqual('string');
        console.log(`Decrypted: ${decrypted}`);
        expect(decrypted).toEqual(JSON.stringify('Hello, World!'));
    });
    it('should encrypt and decrypt a Uint8Array', async () => {
        const key = encodeBase64(getRandomBytes(32));
        const encrypted = await encryptAESGCM(new TextEncoder().encode('Hello, World!'), key);
        expect(encrypted instanceof Uint8Array).toBe(true);
        const decrypted = await decryptAESGCM(encrypted, key);
        expect(decrypted instanceof Uint8Array).toBe(true);
        expect(decrypted).toEqual(new TextEncoder().encode('Hello, World!'));
    });
});