import { deriveKey } from "@/encryption/deriveKey";
import { AES256Encryption, BoxEncryption, SecretBoxEncryption } from "./encryptor";
import { encodeHex } from "@/encryption/hex";

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

    private constructor(anonID: string, legacyMasterSecret: Uint8Array, contentDataKey: Uint8Array) {
        this.anonID = anonID;
        this.legacyEncryption = new SecretBoxEncryption(legacyMasterSecret);
        this.contentEncryption = new BoxEncryption(contentDataKey);
    }

    async openEncryption(dataEncryptionKey: Uint8Array | null) {
        if (!dataEncryptionKey) {
            return this.legacyEncryption;
        }
        const decrypted = await this.contentEncryption.decrypt([dataEncryptionKey]);
        if (!decrypted || !decrypted[0]) {
            throw Error('Failed to decrypt data encryption key');
        }
        return new AES256Encryption(decrypted[0]);
    }
}