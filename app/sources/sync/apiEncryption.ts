import { getRandomBytes } from 'expo-crypto';
import * as tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@/auth/base64';
import { AgentState, AgentStateSchema, DecryptedMessage, MessageContent, MessageContentSchema, Metadata, MetadataSchema } from './storageTypes';
import { ApiMessage } from './apiTypes';

export function encrypt(data: any, secret: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
    const encrypted = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
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

export class ApiEncryption {
    private secretKey: Uint8Array;

    constructor(secretKeyBase64url: string) {
        // Decode the secret key from base64url
        this.secretKey = decodeBase64(secretKeyBase64url, 'base64url');

        // Ensure the key is the correct length for secretbox (32 bytes)
        if (this.secretKey.length !== tweetnacl.secretbox.keyLength) {
            throw new Error(`Invalid secret key length: ${this.secretKey.length}, expected ${tweetnacl.secretbox.keyLength}`);
        }
    }

    decryptMetadata(encryptedMetadata: string): Metadata | null {
        const encryptedData = decodeBase64(encryptedMetadata, 'base64');
        const decrypted = decrypt(encryptedData, this.secretKey);
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
        const decrypted = decrypt(encryptedData, this.secretKey);
        if (!decrypted) {
            return {};
        }
        const parsed = AgentStateSchema.safeParse(decrypted);
        if (!parsed.success) {
            return {};
        }
        return parsed.data;
    }

    decryptMessage(encryptedMessage: ApiMessage | null | undefined): DecryptedMessage | null {
        if (!encryptedMessage) {
            return null;
        }
        if (encryptedMessage.content.t === 'encrypted') {
            const decrypted = this.decrypt(encryptedMessage.content.c);
            if (!decrypted) {
                return {
                    id: encryptedMessage.id,
                    seq: encryptedMessage.seq,
                    localId: encryptedMessage.localId ?? null,
                    content: null,
                    createdAt: encryptedMessage.createdAt,
                }
            }
            return {
                id: encryptedMessage.id,
                seq: encryptedMessage.seq,
                localId: encryptedMessage.localId ?? null,
                content: decrypted,
                createdAt: encryptedMessage.createdAt,
            }
        } else {
            return {
                id: encryptedMessage.id,
                seq: encryptedMessage.seq,
                localId: encryptedMessage.localId ?? null,
                content: null,
                createdAt: encryptedMessage.createdAt,
            }
        }
    }

    encrypt(data: MessageContent): string {
        try {
            const encrypted = encrypt(data, this.secretKey);
            return encodeBase64(encrypted, 'base64');
        } catch (error) {
            console.error('Encryption failed:', error);
            throw error;
        }
    }

    decrypt(encryptedContent: string): MessageContent | null {
        try {
            const encryptedData = decodeBase64(encryptedContent, 'base64');
            const decrypted = decrypt(encryptedData, this.secretKey);
            if (!decrypted) {
                return null;
            }
            const parsed = MessageContentSchema.safeParse(decrypted);
            if (!parsed.success) {
                return null;
            }
            return parsed.data;
        } catch (error) {
            console.error('Decryption failed:', error);
            return null;
        }
    }


    encryptRaw(data: any): string {
        try {
            const encrypted = encrypt(data, this.secretKey);
            return encodeBase64(encrypted, 'base64');
        } catch (error) {
            console.error('Encryption failed:', error);
            throw error;
        }
    }

    decryptRaw(encryptedContent: string): any | null {
        try {
            const encryptedData = decodeBase64(encryptedContent, 'base64');
            const decrypted = decrypt(encryptedData, this.secretKey);
            if (!decrypted) {
                return null;
            }
            return decrypted;
        } catch (error) {
            return null;
        }
    }
}