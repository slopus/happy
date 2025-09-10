import { deriveKey } from "@/encryption/deriveKey";
import { AES256Encryption, BoxEncryption, SecretBoxEncryption, Encryptor, Decryptor } from "./encryptor";
import { encodeHex } from "@/encryption/hex";
import { EncryptionCache } from "./encryptionCache";
import { SessionEncryption } from "./sessionEncryption";
import { encodeBase64, decodeBase64 } from "@/auth/base64";

export class Encryption {

    static async create(masterSecret: Uint8Array) {

        // It is the same as the master secret
        let legacyMasterSecret = masterSecret;

        // Derive content data key to open session and machine records
        const contentDataKey = await deriveKey(masterSecret, 'Happy EnCoder', ['content']);

        // Derive anonymous ID
        const anonID = encodeHex((await deriveKey(masterSecret, 'Happy Coder', ['analytics', 'id']))).slice(0, 16).toLowerCase();

        // Create encryption
        return new Encryption(anonID, legacyMasterSecret, contentDataKey);
    }

    private readonly legacyEncryption: SecretBoxEncryption;
    private readonly contentEncryption: BoxEncryption;
    readonly anonID: string;

    // Session and machine encryption management
    private sessionEncryptions = new Map<string, SessionEncryption>();
    private sessionDataKeys = new Map<string, Uint8Array>();
    private machineEncryptions = new Map<string, SessionEncryption>(); // Machine encryption uses same class
    private cache: EncryptionCache;

    private constructor(anonID: string, legacyMasterSecret: Uint8Array, contentDataKey: Uint8Array) {
        this.anonID = anonID;
        this.legacyEncryption = new SecretBoxEncryption(legacyMasterSecret);
        this.contentEncryption = new BoxEncryption(contentDataKey);
        this.cache = new EncryptionCache();
    }

    //
    // Core encryption opening
    //

    async openEncryption(dataEncryptionKey: Uint8Array | null): Promise<Encryptor & Decryptor> {
        if (!dataEncryptionKey) {
            return this.legacyEncryption;
        }
        const decrypted = await this.contentEncryption.decrypt([dataEncryptionKey]);
        if (!decrypted || !decrypted[0]) {
            throw Error('Failed to decrypt data encryption key');
        }
        return new AES256Encryption(decrypted[0]);
    }

    //
    // Session operations
    //

    /**
     * Initialize sessions with their encryption keys
     * This should be called once when sessions are loaded
     */
    async initializeSessions(sessions: Map<string, Uint8Array | null>): Promise<void> {
        for (const [sessionId, dataKey] of sessions) {
            // Skip if already initialized
            if (this.sessionEncryptions.has(sessionId)) {
                continue;
            }

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey);

            // Create and cache session encryption
            const sessionEnc = new SessionEncryption(
                sessionId,
                encryptor,
                this.cache
            );

            this.sessionEncryptions.set(sessionId, sessionEnc);
            if (dataKey) {
                this.sessionDataKeys.set(sessionId, dataKey);
            }
        }
    }

    /**
     * Get session encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getSessionEncryption(sessionId: string): SessionEncryption | null {
        return this.sessionEncryptions.get(sessionId) || null;
    }

    //
    // Legacy methods for machine metadata (temporary until machines are migrated)
    //

    async encryptRaw(data: any): Promise<string> {
        const encrypted = await this.legacyEncryption.encrypt([data]);
        return encodeBase64(encrypted[0], 'base64');
    }

    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.legacyEncryption.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch (error) {
            return null;
        }
    }
}