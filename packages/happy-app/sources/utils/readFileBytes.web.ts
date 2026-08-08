/**
 * Read file bytes from a URI — web implementation.
 * Uses fetch() on blob: and data: URIs returned by expo-image-picker on web.
 */
export async function readFileBytes(uri: string, maxBytes?: number): Promise<Uint8Array> {
    const response = await fetch(uri);
    if (!response.ok) {
        throw new Error(`readFileBytes: fetch failed with status ${response.status}`);
    }

    if (maxBytes === undefined) {
        return new Uint8Array(await response.arrayBuffer());
    }

    const declaredLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel();
        throw new Error(`File exceeds the ${maxBytes}-byte read limit`);
    }
    if (!response.body) {
        throw new Error('Bounded file reads are unavailable in this browser');
    }

    const reader = response.body.getReader();
    const output = new Uint8Array(maxBytes);
    let offset = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.length > maxBytes - offset) {
                await reader.cancel();
                throw new Error(`File exceeds the ${maxBytes}-byte read limit`);
            }
            output.set(value, offset);
            offset += value.length;
        }
        return output.subarray(0, offset);
    } finally {
        reader.releaseLock();
    }
}
