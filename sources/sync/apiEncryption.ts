import sodium from 'react-native-libsodium';
import { decodeBase64, encodeBase64 } from '@/auth/base64';
import { AgentState, AgentStateSchema, Metadata, MetadataSchema } from './storageTypes';
import { decryptSecretBox, encryptSecretBox } from '@/encryption/libsodium';
import { deriveKey } from '@/encryption/deriveKey';
import { encodeHex } from '@/encryption/hex';

export class ApiEncryption {

    static async create(secretKeyBase64url: string) {

        // Load key
        const secretKey = decodeBase64(secretKeyBase64url, 'base64url');
        if (secretKey.length !== 32) {
            throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
        }

        // Derive anonymous ID
        const anonID = encodeHex((await deriveKey(secretKey, 'Happy Analytics', ['analytics', 'id']))).slice(0, 16).toLowerCase();

        return new ApiEncryption(secretKey, anonID);
    }

    secretKey: Uint8Array;
    anonID: string;

    constructor(secretKey: Uint8Array, anonID: string) {
        this.secretKey = secretKey;
        this.anonID = anonID;
        Object.freeze(this);
    }

    decryptMetadata(encryptedMetadata: string): Metadata | null {
        const encryptedData = decodeBase64(encryptedMetadata, 'base64');
        const decrypted = decryptSecretBox(encryptedData, this.secretKey);
        if (!decrypted) {
            return null;
        }
        const parsed = MetadataSchema.safeParse(decrypted);
        if (!parsed.success) {
            return null;
        }
        return parsed.data;
    }

    decryptAgentState(encryptedAgentState: string | null | undefined): AgentState {
        if (!encryptedAgentState) {
            return {};
        }
        const encryptedData = decodeBase64(encryptedAgentState, 'base64');
        const decrypted = decryptSecretBox(encryptedData, this.secretKey);
        if (!decrypted) {
            return {};
        }
        const parsed = AgentStateSchema.safeParse(decrypted);
        if (!parsed.success) {
            return {};
        }
        return parsed.data;
    }

    encryptRaw(data: any): string {
        try {
            const encrypted = encryptSecretBox(data, this.secretKey);
            return encodeBase64(encrypted, 'base64');
        } catch (error) {
            console.error('Encryption failed:', error);
            throw error;
        }
    }

    decryptRaw(encryptedContent: string): any | null {
        try {
            const encryptedData = decodeBase64(encryptedContent, 'base64');
            const decrypted = decryptSecretBox(encryptedData, this.secretKey);
            if (!decrypted) {
                return null;
            }
            return decrypted;
        } catch (error) {
            return null;
        }
    }
}