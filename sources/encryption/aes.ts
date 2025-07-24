import { decodeBase64 } from '@/auth/base64';
import * as crypto from 'rn-encryption';

export function encryptAES(data: any, key: string): string {
    return crypto.encryptAES(new TextEncoder().encode(JSON.stringify(data)), key);
}

export function decryptAES(data: string, key: string): any {
    const decrypted = crypto.decryptAES(data, key);
    if (!decrypted) {
        return null;
    }
    return JSON.parse(new TextDecoder().decode(decodeBase64(decrypted)));
}