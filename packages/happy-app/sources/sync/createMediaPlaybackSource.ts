import {
    cacheDirectory,
    deleteAsync,
    createDownloadResumable,
    makeDirectoryAsync,
} from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';
import { AttachmentTransferTimeoutError, transferAbortReason, type AttachmentTransferOptions } from './attachmentTransfer';

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

function ownedMediaSource(uri: string, cleanupUri: string): MediaPlaybackSource {
    let owners = 0;
    const lease = (): MediaPlaybackSource => {
        owners += 1;
        let released = false;
        return {
            uri, headers: {},
            retain: () => {
                if (released) throw new Error('Media source already released');
                return lease();
            },
            release: async () => {
                if (released) return;
                released = true;
                owners -= 1;
                if (owners === 0) await deleteAsync(cleanupUri, { idempotent: true });
            },
        };
    };
    return lease();
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
    return ownedMediaSource(target.uri, target.cleanupUri);
}

/** Stream generated media into a typed native cache file before WebView playback. */
export async function downloadMediaPlaybackSource(
    source: { uri: string; headers: Record<string, string> },
    mimeType: string,
    fileName?: string,
    options: AttachmentTransferOptions = {},
): Promise<MediaPlaybackSource> {
    if (options.signal?.aborted) throw transferAbortReason(options.signal);
    const target = createMediaCacheTarget(mimeType, fileName);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let written = 0;
    let rejectStop!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = (reason: unknown) => {
        if (stopped) return;
        stopped = true;
        rejectStop(reason);
        void task.cancelAsync().catch(() => {});
    };
    const armDeadline = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stop(new AttachmentTransferTimeoutError()), options.stallTimeoutMs ?? 45_000);
    };
    const task = createDownloadResumable(source.uri, target.uri, { headers: source.headers }, progress => {
        if (stopped) return;
        if (progress.totalBytesWritten > written) {
            written = progress.totalBytesWritten;
            armDeadline();
        }
        options.onProgress?.({ bytesWritten: progress.totalBytesWritten,
            ...(progress.totalBytesExpectedToWrite > 0 ? { totalBytes: progress.totalBytesExpectedToWrite } : {}) });
    });
    const abort = () => stop(transferAbortReason(options.signal!));
    try {
        if (target.directory) await makeDirectoryAsync(target.directory, { intermediates: true });
        if (options.signal?.aborted) throw transferAbortReason(options.signal);
        options.signal?.addEventListener('abort', abort);
        armDeadline();
        const download = task.downloadAsync();
        // A native cancellation can settle after the UI has already timed out.
        // Only clean its partial file once native IO has actually stopped.
        void download.then(() => { if (stopped) void deleteAsync(target.cleanupUri, { idempotent: true }).catch(() => {}); },
            () => { if (stopped) void deleteAsync(target.cleanupUri, { idempotent: true }).catch(() => {}); });
        const result = await Promise.race([download, interrupted]);
        if (!result) throw new Error('Media download cancelled');
        if (result.status < 200 || result.status >= 300) {
            throw new Error(`Media download failed: ${result.status}`);
        }
        return ownedMediaSource(result.uri, target.cleanupUri);
    } catch (error) {
        if (!stopped) await deleteAsync(target.cleanupUri, { idempotent: true });
        throw error;
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
    }
}
