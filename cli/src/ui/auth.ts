import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { configuration } from "@/configuration";
import { randomBytes } from "node:crypto";
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { displayQRCode } from "./qrcode";
import { delay } from "@/utils/time";
import { writeCredentials } from "@/persistence/persistence";

export async function doAuth(): Promise<{ secret: Uint8Array, token: string } | null> {

    console.log('Starting authentication...');

    // Generating ephemeral key
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);

    // Create a new authentication request
    try {
        await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
            publicKey: encodeBase64(keypair.publicKey),
        });
    } catch (error) {
        console.log('Failed to create authentication request, please try again later.');
        return null;
    }

    // Show QR code
    console.log('Please, authenticate using mobile app');
    const authUrl = 'happy://terminal?' + encodeBase64Url(keypair.publicKey);
    displayQRCode(authUrl);
    
    // NOTE: For local development for now
    // In the future this will be a deep link to our website you can click
    // to either download the app or open the web app.
    console.log('\n📋 For manual entry, copy this URL:');
    console.log(authUrl);

    // Wait for authentication
    let credentials: { secret: Uint8Array, token: string } | null = null;
    while (true) {
        try {
            const response = await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
                publicKey: encodeBase64(keypair.publicKey),
            });
            if (response.data.state === 'authorized') {
                let token = response.data.token as string;
                let r = decodeBase64(response.data.response);
                let decrypted = decryptWithEphemeralKey(r, keypair.secretKey);
                if (decrypted) {
                    credentials = {
                        secret: decrypted,
                        token: token
                    }
                    await writeCredentials(credentials);
                    return credentials;
                } else {
                    console.log('Failed to decrypt response, please try again later.');
                    return null;
                }
            }
        } catch (error) {
            console.log('Failed to create authentication request, please try again later.');
            return null;
        }
        await delay(1000);
    }

    return null;
}

export function decryptWithEphemeralKey(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    // Extract components from bundle: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
    const ephemeralPublicKey = encryptedBundle.slice(0, 32);
    const nonce = encryptedBundle.slice(32, 32 + tweetnacl.box.nonceLength);
    const encrypted = encryptedBundle.slice(32 + tweetnacl.box.nonceLength);

    const decrypted = tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
    if (!decrypted) {
        return null;
    }

    return decrypted;
}