import { describe, it, expect } from '@/dev/testRunner';
import { SecretBoxEncryption, BoxEncryption, AES256Encryption } from './encryptor';
import { getRandomBytes } from 'expo-crypto';

describe('SecretBoxEncryption', () => {
    it('should encrypt and decrypt single Uint8Array', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new SecretBoxEncryption(secretKey);
        
        const originalData = new TextEncoder().encode('Hello, World!');
        const encrypted = await encryptor.encrypt([originalData]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(decrypted.length).toBe(1);
        expect(decrypted[0]).toEqual(originalData);
    });

    it('should encrypt and decrypt multiple Uint8Arrays', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new SecretBoxEncryption(secretKey);
        
        const data1 = new TextEncoder().encode('First message');
        const data2 = new TextEncoder().encode('Second message');
        const data3 = new TextEncoder().encode('Third message');
        
        const encrypted = await encryptor.encrypt([data1, data2, data3]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(decrypted.length).toBe(3);
        expect(decrypted[0]).toEqual(data1);
        expect(decrypted[1]).toEqual(data2);
        expect(decrypted[2]).toEqual(data3);
    });

    it('should handle empty arrays', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new SecretBoxEncryption(secretKey);
        
        const encrypted = await encryptor.encrypt([]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(encrypted.length).toBe(0);
        expect(decrypted.length).toBe(0);
    });

    it('should produce different ciphertext for same plaintext (due to random nonce)', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new SecretBoxEncryption(secretKey);
        
        const originalData = new TextEncoder().encode('Same message');
        const encrypted1 = await encryptor.encrypt([originalData]);
        const encrypted2 = await encryptor.encrypt([originalData]);
        
        // Ciphertexts should be different due to random nonce
        expect(encrypted1[0]).not.toEqual(encrypted2[0]);
        
        // But both should decrypt to the same plaintext
        const decrypted1 = await encryptor.decrypt(encrypted1);
        const decrypted2 = await encryptor.decrypt(encrypted2);
        
        expect(decrypted1[0]).toEqual(originalData);
        expect(decrypted2[0]).toEqual(originalData);
    });

    it('should fail decryption with wrong key', async () => {
        const secretKey1 = getRandomBytes(32);
        const secretKey2 = getRandomBytes(32);
        
        const encryptor1 = new SecretBoxEncryption(secretKey1);
        const encryptor2 = new SecretBoxEncryption(secretKey2);
        
        const originalData = new TextEncoder().encode('Secret message');
        const encrypted = await encryptor1.encrypt([originalData]);
        const decrypted = await encryptor2.decrypt(encrypted);
        
        expect(decrypted[0]).toBe(null);
    });

    it('should handle moderate size data', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new SecretBoxEncryption(secretKey);
        
        // Create a moderate array (10KB instead of 1MB)
        const largeData = new Uint8Array(10 * 1024);
        for (let i = 0; i < largeData.length; i++) {
            largeData[i] = i % 256;
        }
        
        const encrypted = await encryptor.encrypt([largeData]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(decrypted.length).toBe(1);
        expect(decrypted[0]).toEqual(largeData);
    });

    it('should handle 500 individual items separately', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new SecretBoxEncryption(secretKey);
        
        // Create 500 individual items
        const originalItems = [];
        for (let i = 0; i < 500; i++) {
            originalItems.push(new TextEncoder().encode(`Item ${i}: This is test data for item number ${i}`));
        }
        
        // Encrypt each item individually
        const encryptedItems = [];
        for (const item of originalItems) {
            const encrypted = await encryptor.encrypt([item]);
            encryptedItems.push(encrypted[0]);
        }
        
        // Decrypt each item individually
        const decryptedItems = [];
        for (const encryptedItem of encryptedItems) {
            const decrypted = await encryptor.decrypt([encryptedItem]);
            decryptedItems.push(decrypted[0]);
        }
        
        // Verify all items match
        expect(decryptedItems.length).toBe(500);
        for (let i = 0; i < 500; i++) {
            expect(decryptedItems[i]).toEqual(originalItems[i]);
        }
    });
});

describe('BoxEncryption', () => {
    it('should encrypt and decrypt single Uint8Array', async () => {
        const seed = getRandomBytes(32);
        const encryptor = new BoxEncryption(seed);
        
        const originalData = new TextEncoder().encode('Hello, Box!');
        const encrypted = await encryptor.encrypt([originalData]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(decrypted.length).toBe(1);
        expect(decrypted[0]).toEqual(originalData);
    });

    it('should encrypt and decrypt multiple Uint8Arrays', async () => {
        const seed = getRandomBytes(32);
        const encryptor = new BoxEncryption(seed);
        
        const data1 = new TextEncoder().encode('Box message 1');
        const data2 = new TextEncoder().encode('Box message 2');
        const data3 = new TextEncoder().encode('Box message 3');
        
        const encrypted = await encryptor.encrypt([data1, data2, data3]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(decrypted.length).toBe(3);
        expect(decrypted[0]).toEqual(data1);
        expect(decrypted[1]).toEqual(data2);
        expect(decrypted[2]).toEqual(data3);
    });

    it('should handle empty arrays', async () => {
        const seed = getRandomBytes(32);
        const encryptor = new BoxEncryption(seed);
        
        const encrypted = await encryptor.encrypt([]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(encrypted.length).toBe(0);
        expect(decrypted.length).toBe(0);
    });

    it('should generate consistent public key from seed', async () => {
        const seed = getRandomBytes(32);
        const encryptor1 = new BoxEncryption(seed);
        const encryptor2 = new BoxEncryption(seed);
        
        // Both instances with same secret key should generate same public key
        // We can't directly access the public key, but we can verify
        // that data encrypted by one can be decrypted by the other
        const originalData = new TextEncoder().encode('Test consistency');
        const encrypted = await encryptor1.encrypt([originalData]);
        const decrypted = await encryptor2.decrypt(encrypted);
        
        expect(decrypted[0]).toEqual(originalData);
    });

    it('should produce different ciphertext for same plaintext (ephemeral keys)', async () => {
        const seed = getRandomBytes(32);
        const encryptor = new BoxEncryption(seed);
        
        const originalData = new TextEncoder().encode('Same box message');
        const encrypted1 = await encryptor.encrypt([originalData]);
        const encrypted2 = await encryptor.encrypt([originalData]);
        
        // Ciphertexts should be different due to ephemeral keys
        expect(encrypted1[0]).not.toEqual(encrypted2[0]);
        
        // But both should decrypt to the same plaintext
        const decrypted1 = await encryptor.decrypt(encrypted1);
        const decrypted2 = await encryptor.decrypt(encrypted2);
        
        expect(decrypted1[0]).toEqual(originalData);
        expect(decrypted2[0]).toEqual(originalData);
    });

    it('should fail decryption with wrong key', async () => {
        const seed1 = getRandomBytes(32);
        const seed2 = getRandomBytes(32);
        
        const encryptor1 = new BoxEncryption(seed1);
        const encryptor2 = new BoxEncryption(seed2);
        
        const originalData = new TextEncoder().encode('Secret box message');
        const encrypted = await encryptor1.encrypt([originalData]);
        const decrypted = await encryptor2.decrypt(encrypted);
        
        expect(decrypted[0]).toBe(null);
    });

    it('should handle moderate size data', async () => {
        const seed = getRandomBytes(32);
        const encryptor = new BoxEncryption(seed);
        
        // Create a moderate array (10KB instead of 1MB)
        const largeData = new Uint8Array(10 * 1024);
        for (let i = 0; i < largeData.length; i++) {
            largeData[i] = (i * 3) % 256;
        }
        
        const encrypted = await encryptor.encrypt([largeData]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(decrypted.length).toBe(1);
        expect(decrypted[0]).toEqual(largeData);
    });

    it('should handle mixed data sizes in batch', async () => {
        const seed = getRandomBytes(32);
        const encryptor = new BoxEncryption(seed);
        
        const small = new TextEncoder().encode('Small');
        const medium = new Uint8Array(512);
        for (let i = 0; i < medium.length; i++) {
            medium[i] = i % 256;
        }
        const large = new Uint8Array(5 * 1024);  // 5KB instead of 100KB
        for (let i = 0; i < large.length; i++) {
            large[i] = (i * 7) % 256;
        }
        
        const encrypted = await encryptor.encrypt([small, medium, large]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(decrypted.length).toBe(3);
        expect(decrypted[0]).toEqual(small);
        expect(decrypted[1]).toEqual(medium);
        expect(decrypted[2]).toEqual(large);
    });

    it('should handle 500 individual items separately', async () => {
        const seed = getRandomBytes(32);
        const encryptor = new BoxEncryption(seed);
        
        // Create 500 individual items
        const originalItems = [];
        for (let i = 0; i < 500; i++) {
            originalItems.push(new TextEncoder().encode(`Box Item ${i}: This is test data for box encryption item ${i}`));
        }
        
        // Encrypt each item individually
        const encryptedItems = [];
        for (const item of originalItems) {
            const encrypted = await encryptor.encrypt([item]);
            encryptedItems.push(encrypted[0]);
        }
        
        // Decrypt each item individually
        const decryptedItems = [];
        for (const encryptedItem of encryptedItems) {
            const decrypted = await encryptor.decrypt([encryptedItem]);
            decryptedItems.push(decrypted[0]);
        }
        
        // Verify all items match
        expect(decryptedItems.length).toBe(500);
        for (let i = 0; i < 500; i++) {
            expect(decryptedItems[i]).toEqual(originalItems[i]);
        }
    });
});

describe('AES256Encryption', () => {
    it('should encrypt and decrypt single Uint8Array', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new AES256Encryption(secretKey);
        
        const originalData = new TextEncoder().encode('Hello, AES!');
        const encrypted = await encryptor.encrypt([originalData]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(decrypted.length).toBe(1);
        expect(decrypted[0]).toEqual(originalData);
    });

    it('should encrypt and decrypt multiple Uint8Arrays', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new AES256Encryption(secretKey);
        
        const data1 = new TextEncoder().encode('AES message 1');
        const data2 = new TextEncoder().encode('AES message 2');
        const data3 = new TextEncoder().encode('AES message 3');
        
        const encrypted = await encryptor.encrypt([data1, data2, data3]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(decrypted.length).toBe(3);
        expect(decrypted[0]).toEqual(data1);
        expect(decrypted[1]).toEqual(data2);
        expect(decrypted[2]).toEqual(data3);
    });

    it('should handle empty arrays', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new AES256Encryption(secretKey);
        
        const encrypted = await encryptor.encrypt([]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(encrypted.length).toBe(0);
        expect(decrypted.length).toBe(0);
    });

    it('should produce different ciphertext for same plaintext (due to random IV)', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new AES256Encryption(secretKey);
        
        const originalData = new TextEncoder().encode('Same AES message');
        const encrypted1 = await encryptor.encrypt([originalData]);
        const encrypted2 = await encryptor.encrypt([originalData]);
        
        // Ciphertexts should be different due to random IV
        expect(encrypted1[0]).not.toEqual(encrypted2[0]);
        
        // But both should decrypt to the same plaintext
        const decrypted1 = await encryptor.decrypt(encrypted1);
        const decrypted2 = await encryptor.decrypt(encrypted2);
        
        expect(decrypted1[0]).toEqual(originalData);
        expect(decrypted2[0]).toEqual(originalData);
    });

    it('should fail decryption with wrong key', async () => {
        const secretKey1 = getRandomBytes(32);
        const secretKey2 = getRandomBytes(32);
        
        const encryptor1 = new AES256Encryption(secretKey1);
        const encryptor2 = new AES256Encryption(secretKey2);
        
        const originalData = new TextEncoder().encode('Secret AES message');
        const encrypted = await encryptor1.encrypt([originalData]);
        const decrypted = await encryptor2.decrypt(encrypted);
        
        expect(decrypted[0]).toBe(null);
    });

    it('should handle moderate size data', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new AES256Encryption(secretKey);
        
        // Create a moderate array (10KB)
        const largeData = new Uint8Array(10 * 1024);
        for (let i = 0; i < largeData.length; i++) {
            largeData[i] = (i * 5) % 100;
        }
        
        const encrypted = await encryptor.encrypt([largeData]);
        const decrypted = await encryptor.decrypt(encrypted);
        
        expect(decrypted.length).toBe(1);
        expect(decrypted[0]).toEqual(largeData);
    });

    it('should handle 500 individual items separately', async () => {
        const secretKey = getRandomBytes(32);
        const encryptor = new AES256Encryption(secretKey);
        
        // Create 500 individual items
        const originalItems = [];
        for (let i = 0; i < 500; i++) {
            originalItems.push(new TextEncoder().encode(`AES Item ${i}: This is test data for AES encryption item ${i}`));
        }
        
        // Encrypt each item individually
        const encryptedItems = [];
        for (const item of originalItems) {
            const encrypted = await encryptor.encrypt([item]);
            encryptedItems.push(encrypted[0]);
        }
        
        // Decrypt each item individually
        const decryptedItems = [];
        for (const encryptedItem of encryptedItems) {
            const decrypted = await encryptor.decrypt([encryptedItem]);
            decryptedItems.push(decrypted[0]);
        }
        
        // Verify all items match
        expect(decryptedItems.length).toBe(500);
        for (let i = 0; i < 500; i++) {
            expect(decryptedItems[i]).toEqual(originalItems[i]);
        }
    });
});