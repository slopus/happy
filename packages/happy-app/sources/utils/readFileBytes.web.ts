/**
 * Read file bytes from a URI — web implementation.
 * Uses fetch() on blob: and data: URIs returned by expo-image-picker on web.
 */
export async function readFileBytes(uri: string): Promise<Uint8Array> {
    const response = await fetch(uri);
    if (!response.ok) {
        throw new Error(`readFileBytes: fetch failed with status ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
}
