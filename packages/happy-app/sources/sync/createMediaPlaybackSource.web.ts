import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';

/** Keep decrypted media out of base64 strings on Web and release it on collapse. */
export async function createMediaPlaybackSource(
    bytes: Uint8Array,
    mimeType: string,
    _fileName?: string,
): Promise<MediaPlaybackSource> {
    const standalone = new Uint8Array(bytes);
    const objectUrl = URL.createObjectURL(new Blob([standalone.buffer], { type: mimeType }));
    return {
        uri: objectUrl,
        headers: {},
        release: () => URL.revokeObjectURL(objectUrl),
    };
}

/** Download authenticated media into a revocable browser object URL. */
export async function downloadMediaPlaybackSource(
    source: { uri: string; headers: Record<string, string> },
    mimeType: string,
    _fileName?: string,
): Promise<MediaPlaybackSource> {
    const response = await fetch(source.uri, { headers: source.headers });
    if (!response.ok) throw new Error(`Media download failed: ${response.status}`);
    const downloaded = await response.blob();
    const blob = downloaded.type
        ? downloaded
        : new Blob([await downloaded.arrayBuffer()], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    return {
        uri: objectUrl,
        headers: {},
        release: () => URL.revokeObjectURL(objectUrl),
    };
}
