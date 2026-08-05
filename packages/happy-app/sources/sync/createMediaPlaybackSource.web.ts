import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';

/** Keep decrypted media out of base64 strings on Web and release it on collapse. */
export async function createMediaPlaybackSource(
    bytes: Uint8Array,
    mimeType: string,
): Promise<MediaPlaybackSource> {
    const standalone = new Uint8Array(bytes);
    const objectUrl = URL.createObjectURL(new Blob([standalone.buffer], { type: mimeType }));
    return {
        uri: objectUrl,
        headers: {},
        release: () => URL.revokeObjectURL(objectUrl),
    };
}
