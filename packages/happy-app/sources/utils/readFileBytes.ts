/**
 * Read file bytes from a URI — native implementation.
 * Uses expo-file-system/legacy to read file:// URIs on iOS/Android.
 */
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { decodeBase64 } from '@/encryption/base64';

export async function readFileBytes(uri: string): Promise<Uint8Array> {
    const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
    return decodeBase64(base64);
}
