import sodium from 'react-native-libsodium';
import { decodeBase64, encodeBase64 } from '@/auth/base64';
import { AgentState, AgentStateSchema, Metadata, MetadataSchema } from '../storageTypes';
import { decryptSecretBox, encryptSecretBox } from '@/encryption/libsodium';
import { deriveKey } from '@/encryption/deriveKey';
import { encodeHex } from '@/encryption/hex';
import { EncryptionCache } from './encryptionCache';

export class ApiEncryption {

    static async create(secretKeyBase64url: string, cache?: EncryptionCache) {

        // Load key
        const secretKey = decodeBase64(secretKeyBase64url, 'base64url');
        if (secretKey.length !== 32) {
            throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
        }

        // Derive anonymous ID
        const anonID = encodeHex((await deriveKey(secretKey, 'Happy Coder', ['analytics', 'id']))).slice(0, 16).toLowerCase();

        return new ApiEncryption(secretKey, anonID, cache);
    }

    secretKey: Uint8Array;
    anonID: string;
    private cache: EncryptionCache;

    constructor(secretKey: Uint8Array, anonID: string, cache?: EncryptionCache) {
        this.secretKey = secretKey;
        this.anonID = anonID;
        this.cache = cache || new EncryptionCache();
        Object.freeze(this);
    }

    decryptMetadata(sessionId: string, version: number, encryptedMetadata: string): Metadata | null {
        // Check cache first
        const cached = this.cache.getCachedMetadata(sessionId, version);
        if (cached) {
            return cached;
        }

        // Decrypt if not cached
        const encryptedData = decodeBase64(encryptedMetadata, 'base64');
        const decrypted = decryptSecretBox(encryptedData, this.secretKey);
        if (!decrypted) {
            return null;
        }
        const parsed = MetadataSchema.safeParse(decrypted);
        if (!parsed.success) {
            return null;
        }

        // Cache the result
        this.cache.setCachedMetadata(sessionId, version, parsed.data);
        return parsed.data;
    }

    decryptAgentState(sessionId: string, version: number, encryptedAgentState: string | null | undefined): AgentState {
        if (!encryptedAgentState) {
            return {};
        }

        // Check cache first
        const cached = this.cache.getCachedAgentState(sessionId, version);
        if (cached) {
            return cached;
        }

        // Decrypt if not cached
        const encryptedData = decodeBase64(encryptedAgentState, 'base64');
        const decrypted = decryptSecretBox(encryptedData, this.secretKey);
        if (!decrypted) {
            return {};
        }
        const parsed = AgentStateSchema.safeParse(decrypted);
        if (!parsed.success) {
            return {};
        }

        // Cache the result
        this.cache.setCachedAgentState(sessionId, version, parsed.data);
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