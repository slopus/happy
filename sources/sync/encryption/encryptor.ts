import { decryptBox, decryptSecretBox, encryptBox, encryptSecretBox } from "@/encryption/libsodium";
import { encodeBase64, decodeBase64 } from "@/auth/base64";
import * as crypto from 'rn-encryption';
import sodium from 'react-native-libsodium';
import { decodeUTF8, encodeUTF8 } from "@/encryption/text";

//
// IMPORTANT: Right now there is a bug in the AES implementation and it works only with a normal strings converted to Uint8Array. 
// Any abnormal string might break encoding and decoding utf8.
//

export interface Encryptor {
    encrypt(data: Uint8Array[]): Promise<Uint8Array[]>;
}

export interface Decryptor {
    decrypt(data: Uint8Array[]): Promise<(Uint8Array | null)[]>;
}

export class SecretBoxEncryption implements Encryptor, Decryptor {
    private readonly secretKey: Uint8Array;

    constructor(secretKey: Uint8Array) {
        this.secretKey = secretKey;
    }

    decrypt(data: Uint8Array[]): Promise<(Uint8Array | null)[]> {
        return Promise.all(data.map(d => decryptSecretBox(d, this.secretKey)));
    }
    encrypt(data: Uint8Array[]): Promise<Uint8Array[]> {
        return Promise.all(data.map(d => encryptSecretBox(d, this.secretKey)));
    }
}

export class BoxEncryption implements Encryptor, Decryptor {
    private readonly privateKey: Uint8Array;
    private readonly publicKey: Uint8Array;

    constructor(seed: Uint8Array) {
        // Use the seed to generate a proper keypair
        const keypair = sodium.crypto_box_seed_keypair(seed);
        this.privateKey = keypair.privateKey;
        this.publicKey = keypair.publicKey;
    }

    encrypt(data: Uint8Array[]): Promise<Uint8Array[]> {
        return Promise.all(data.map(d => encryptBox(d, this.publicKey)));
    }

    decrypt(data: Uint8Array[]): Promise<(Uint8Array | null)[]> {
        return Promise.all(data.map(d => decryptBox(d, this.privateKey)));
    }
}

export class AES256Encryption implements Encryptor, Decryptor {
    private readonly secretKey: Uint8Array;
    private readonly secretKeyB64: string;

    constructor(secretKey: Uint8Array) {
        this.secretKey = secretKey;
        this.secretKeyB64 = encodeBase64(secretKey);
    }

    async encrypt(data: Uint8Array[]): Promise<Uint8Array[]> {
        return Promise.all(data.map(async d => {
            return decodeBase64(await crypto.encryptAES(decodeUTF8(d), this.secretKeyB64));
        }));
    }

    async decrypt(data: Uint8Array[]): Promise<(Uint8Array | null)[]> {
        return Promise.all(data.map(async d => {
            try {
                const decryptedBase64 = await crypto.decryptAES(encodeBase64(d), this.secretKeyB64);
                if (!decryptedBase64) {
                    return null;
                }
                return encodeUTF8(decryptedBase64);
            } catch (error) {
                return null;
            }
        }));
    }
}