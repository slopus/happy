interface CanvasAssetRef {
    attachmentId: string;
}

const assets = new Map<string, string>();

export function setAssetUri(key: string, uri: string): void {
    assets.set(key, uri);
}

export function removeAssetUri(key: string): void {
    assets.delete(key);
}

/** The project owns the URI and release lifetime. The iframe never sends it to another origin. */
export async function fetchAttachmentBlob(attachment: CanvasAssetRef): Promise<Blob> {
    const uri = assets.get(String(attachment.attachmentId));
    if (!uri) throw new Error('Canvas asset is unavailable');
    return fetchDisplayBlob(uri);
}

export async function fetchDisplayBlob(uri: string): Promise<Blob> {
    const response = await fetch(uri, { credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error('Canvas asset is unavailable');
    return response.blob();
}

export function clearAttachmentCache(): void {
    assets.clear();
}
