import {
    cacheDirectory,
    deleteAsync,
    downloadAsync,
    EncodingType,
    writeAsStringAsync,
} from 'expo-file-system/legacy';
import { encodeBase64 } from '@/encryption/base64';
import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
};

function createMediaCacheUri(mimeType: string): string {
    if (!cacheDirectory) throw new Error('Media cache directory is unavailable');
    const extension = EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? 'media';
    return `${cacheDirectory}paws-media-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
}

/** Stage decrypted media in the native cache so WebView can play a file URI. */
export async function createMediaPlaybackSource(
    bytes: Uint8Array,
    mimeType: string,
): Promise<MediaPlaybackSource> {
    const uri = createMediaCacheUri(mimeType);
    await writeAsStringAsync(uri, encodeBase64(bytes), { encoding: EncodingType.Base64 });
    return {
        uri,
        headers: {},
        release: () => deleteAsync(uri, { idempotent: true }),
    };
}

/** Stream generated media into a typed native cache file before WebView playback. */
export async function downloadMediaPlaybackSource(
    source: { uri: string; headers: Record<string, string> },
    mimeType: string,
): Promise<MediaPlaybackSource> {
    const uri = createMediaCacheUri(mimeType);
    try {
        const result = await downloadAsync(source.uri, uri, { headers: source.headers });
        if (result.status < 200 || result.status >= 300) {
            throw new Error(`Media download failed: ${result.status}`);
        }
        return {
            uri: result.uri,
            headers: {},
            release: () => deleteAsync(result.uri, { idempotent: true }),
        };
    } catch (error) {
        await deleteAsync(uri, { idempotent: true });
        throw error;
    }
}
