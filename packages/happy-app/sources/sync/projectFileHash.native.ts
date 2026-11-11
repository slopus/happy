import { digest, CryptoDigestAlgorithm } from 'expo-crypto';

export async function projectFileHash(bytes: Uint8Array): Promise<string> {
    return Array.from(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes)))).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
