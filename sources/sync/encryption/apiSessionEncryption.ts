import { decodeBase64, encodeBase64 } from '@/auth/base64';
import { encryptSecretBox, decryptSecretBox } from '@/encryption/libsodium';
import { RawRecord } from '../typesRaw';
import { ApiMessage } from '../apiTypes';
import { DecryptedMessage } from '../storageTypes';
import { EncryptionCache } from './encryptionCache';

export class SessionEncryption {
    private secretKey: Uint8Array;
    private sessionId: string;
    private cache: EncryptionCache;

    constructor(sessionId: string, secretKey: Uint8Array, cache?: EncryptionCache) {
        this.sessionId = sessionId;
        this.secretKey = secretKey;

        // Initialize cache
        this.cache = cache || new EncryptionCache();
    }

    decryptMessage(encryptedMessage: ApiMessage | null | undefined): DecryptedMessage | null {
        if (!encryptedMessage) {
            return null;
        }

        // Check cache first (messages are immutable, so cache by ID)
        const cached = this.cache.getCachedMessage(encryptedMessage.id);
        if (cached) {
            return cached;
        }

        // Create the decrypted message
        let decryptedMessage: DecryptedMessage;

        if (encryptedMessage.content.t === 'encrypted') {
            const decrypted = this.#decrypt(encryptedMessage.content.c);
            if (!decrypted) {
                decryptedMessage = {
                    id: encryptedMessage.id,
                    seq: encryptedMessage.seq,
                    localId: encryptedMessage.localId ?? null,
                    content: null,
                    createdAt: encryptedMessage.createdAt,
                }
            } else {
                decryptedMessage = {
                    id: encryptedMessage.id,
                    seq: encryptedMessage.seq,
                    localId: encryptedMessage.localId ?? null,
                    content: decrypted,
                    createdAt: encryptedMessage.createdAt,
                }
            }
        } else {
            decryptedMessage = {
                id: encryptedMessage.id,
                seq: encryptedMessage.seq,
                localId: encryptedMessage.localId ?? null,
                content: null,
                createdAt: encryptedMessage.createdAt,
            }
        }

        // Cache the result
        this.cache.setCachedMessage(encryptedMessage.id, decryptedMessage);
        return decryptedMessage;
    }

    encryptRawRecord(data: RawRecord): string {
        return this.#encrypt(data);
    }

    //
    // Low level implementation
    //

    #encrypt(data: any): string {
        try {
            const encrypted = encryptSecretBox(data, this.secretKey);
            return encodeBase64(encrypted, 'base64');
        } catch (error) {
            console.error(`Session ${this.sessionId} encryption failed:`, error);
            throw error;
        }
    }

    #decrypt(encryptedContent: string): any | null {
        try {
            const encryptedData = decodeBase64(encryptedContent, 'base64');
            const decrypted = decryptSecretBox(encryptedData, this.secretKey);
            if (!decrypted) {
                return null;
            }
            return decrypted;
        } catch (error) {
            console.error(`Session ${this.sessionId} decryption failed:`, error);
            return null;
        }
    }
}