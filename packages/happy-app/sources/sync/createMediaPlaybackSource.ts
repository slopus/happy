import {
    cacheDirectory,
    deleteAsync,
    downloadAsync,
    makeDirectoryAsync,
} from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
};

type MediaCacheTarget = {
    uri: string;
    cleanupUri: string;
    directory?: string;
};

function safeCacheFileName(fileName: string, fallbackExtension: string): string {
    const baseName = fileName.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '_').trim();
    if (!baseName || baseName === '.' || baseName === '..') return `attachment.${fallbackExtension}`;
    return baseName;
}

function createMediaCacheTarget(mimeType: string, fileName?: string): MediaCacheTarget {
    if (!cacheDirectory) throw new Error('Media cache directory is unavailable');
    const extension = EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? 'media';
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (fileName) {
        const directory = `${cacheDirectory}paws-media-${token}/`;
        return {
            uri: `${directory}${safeCacheFileName(fileName, extension)}`,
            cleanupUri: directory,
            directory,
        };
    }
    const uri = `${cacheDirectory}paws-media-${token}.${extension}`;
    return { uri, cleanupUri: uri };
}

/** Stage decrypted media in the native cache so WebView can play a file URI. */
export async function createMediaPlaybackSource(
    bytes: Uint8Array,
    mimeType: string,
    fileName?: string,
): Promise<MediaPlaybackSource> {
    const target = createMediaCacheTarget(mimeType, fileName);
    if (target.directory) await makeDirectoryAsync(target.directory, { intermediates: true });
    new File(target.uri).write(bytes);
    return {
        uri: target.uri,
        headers: {},
        release: () => deleteAsync(target.cleanupUri, { idempotent: true }),
    };
}

/** Stream generated media into a typed native cache file before WebView playback. */
export async function downloadMediaPlaybackSource(
    source: { uri: string; headers: Record<string, string> },
    mimeType: string,
    fileName?: string,
): Promise<MediaPlaybackSource> {
    const target = createMediaCacheTarget(mimeType, fileName);
    try {
        if (target.directory) await makeDirectoryAsync(target.directory, { intermediates: true });
        const result = await downloadAsync(source.uri, target.uri, { headers: source.headers });
        if (result.status < 200 || result.status >= 300) {
            throw new Error(`Media download failed: ${result.status}`);
        }
        return {
            uri: result.uri,
            headers: {},
            release: () => deleteAsync(target.cleanupUri, { idempotent: true }),
        };
    } catch (error) {
        await deleteAsync(target.cleanupUri, { idempotent: true });
        throw error;
    }
}
