import * as crypto from 'rn-encryption';
import { decodeUTF8, encodeUTF8 } from './text';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

export async function encryptAESGCMString(data: string, key64: string): Promise<string> {
    return await crypto.encryptAsyncAES(data, key64);
}

export async function decryptAESGCMString(data: string, key64: string): Promise<string | null> {
    const res = (await crypto.decryptAsyncAES(data, key64)).trim();
    return res;
}

export async function encryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array> {
    const encrypted = (await crypto.encryptAsyncAES(decodeUTF8(data), key64)).trim();
    return decodeBase64(encrypted);
}
export async function decryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array | null> {
    let raw = await crypto.decryptAsyncAES(encodeBase64(data), key64);
    return raw ? encodeUTF8(raw) : null;
}