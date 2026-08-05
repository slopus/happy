import {
    cacheDirectory,
    deleteAsync,
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

/** Stage decrypted media in the native cache so WebView can play a file URI. */
export async function createMediaPlaybackSource(
    bytes: Uint8Array,
    mimeType: string,
): Promise<MediaPlaybackSource> {
    if (!cacheDirectory) throw new Error('Media cache directory is unavailable');
    const extension = EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? 'media';
    const uri = `${cacheDirectory}paws-media-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
    await writeAsStringAsync(uri, encodeBase64(bytes), { encoding: EncodingType.Base64 });
    return {
        uri,
        headers: {},
        release: () => deleteAsync(uri, { idempotent: true }),
    };
}
