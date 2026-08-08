/**
 * Read file bytes from a URI — native implementation.
 * Uses a bounded native file handle so an underreported provider file cannot
 * allocate past the caller's limit before validation.
 */
import { File } from 'expo-file-system';

export async function readFileBytes(uri: string, maxBytes?: number): Promise<Uint8Array> {
    const handle = new File(uri).open();
    try {
        const size = handle.size;
        if (size === null) throw new Error('File size is unavailable');
        if (maxBytes !== undefined && size > maxBytes) {
            throw new Error(`File exceeds the ${maxBytes}-byte read limit`);
        }
        return handle.readBytes(size);
    } finally {
        handle.close();
    }
}
