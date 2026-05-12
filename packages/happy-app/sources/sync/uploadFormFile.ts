/**
 * Native (iOS/Android) impl: append a Uint8Array to FormData for a multipart
 * upload. RN's Blob polyfill rejects `new Blob([arrayBuffer])`, so we stage
 * the bytes to a temp file in cacheDirectory and use RN FormData's
 * `{ uri, type, name }` form, which the platform multipart writer streams
 * directly off disk. Returns a cleanup that deletes the temp file.
 */
import { encodeBase64 } from '@/encryption/base64';
import { writeAsStringAsync, deleteAsync, cacheDirectory, EncodingType } from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';

export async function appendFormFile(
    formData: FormData,
    bytes: Uint8Array,
    field: string,
    filename: string,
    contentType: string,
): Promise<() => Promise<void>> {
    if (!cacheDirectory) {
        throw new Error('cacheDirectory unavailable on this platform');
    }
    const tempUri = `${cacheDirectory}happy-upload-${randomUUID()}`;
    await writeAsStringAsync(tempUri, encodeBase64(bytes), { encoding: EncodingType.Base64 });
    // RN typings don't know about the {uri, type, name} form, but the runtime does.
    formData.append(field, { uri: tempUri, type: contentType, name: filename } as unknown as Blob);
    return async () => {
        try { await deleteAsync(tempUri, { idempotent: true }); } catch { /* best effort */ }
    };
}
