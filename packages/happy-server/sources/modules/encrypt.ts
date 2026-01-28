import { KeyTree, crypto } from "privacy-kit";

let keyTree: KeyTree | null = null;

export async function initEncrypt() {
    keyTree = new KeyTree(await crypto.deriveSecureKey({
        key: process.env.HANDY_MASTER_SECRET!,
        usage: 'happy-server-tokens'
    }));
}

export function encryptString(path: string[], string: string) {
    return keyTree!.symmetricEncrypt(path, string);
}

export function encryptBytes(path: string[], bytes: Uint8Array<ArrayBuffer>) {
    return keyTree!.symmetricEncrypt(path, bytes);
}

export function decryptString(path: string[], encrypted: Uint8Array<ArrayBuffer>) {
    return keyTree!.symmetricDecryptString(path, encrypted);
}

export function decryptBytes(path: string[], encrypted: Uint8Array<ArrayBuffer>) {
    return keyTree!.symmetricDecryptBuffer(path, encrypted);
}