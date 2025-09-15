import { getRandomBytes } from 'expo-crypto';
import sodium from 'react-native-libsodium';
import axios from 'axios';
import { encodeBase64 } from '../encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';

export interface QRAuthKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export function generateAuthKeyPair(): QRAuthKeyPair {
    const secret = getRandomBytes(32);
    const keypair = sodium.crypto_box_seed_keypair(secret);
    return {
        publicKey: keypair.publicKey,
        secretKey: keypair.privateKey,
    };
}

export async function authQRStart(keypair: QRAuthKeyPair): Promise<boolean> {
    try {
        const serverUrl = getServerUrl();
        // Auth request initiated

        await axios.post(`${serverUrl}/v1/auth/account/request`, {
            publicKey: encodeBase64(keypair.publicKey),
        });

        // Auth request completed successfully
        return true;
    } catch (error) {
        // Authentication request failed
        console.log('Failed to create authentication request, please try again later.');
        return false;
    }
}