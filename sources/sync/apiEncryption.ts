import sodium from 'react-native-libsodium';
import { decodeBase64, encodeBase64 } from '@/auth/base64';
import { AgentState, AgentStateSchema, Metadata, MetadataSchema } from './storageTypes';
import { decryptSecretBox, encryptSecretBox } from '@/encryption/libsodium';

export class ApiEncryption {
    secretKey: Uint8Array;

    constructor(secretKeyBase64url: string) {
        // Decode the secret key from base64url
        this.secretKey = decodeBase64(secretKeyBase64url, 'base64url');

        // Ensure the key is the correct length for secretbox (32 bytes)
        if (this.secretKey.length !== sodium.crypto_secretbox_KEYBYTES) {
            throw new Error(`Invalid secret key length: ${this.secretKey.length}, expected ${sodium.crypto_secretbox_KEYBYTES}`);
        }
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