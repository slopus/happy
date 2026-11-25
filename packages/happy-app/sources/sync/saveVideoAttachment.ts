import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { downloadMediaPlaybackSource } from './createMediaPlaybackSource';
import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';
import type { VideoSaveResult } from './saveVideoAttachment.types';

/** Save a local video without requesting access to the user's existing library. */
export async function saveVideoAttachment(
    source: MediaPlaybackSource,
    fileName: string,
    mimeType: string,
): Promise<VideoSaveResult> {
    const staged = source.uri.startsWith('file://')
        ? source
        : await downloadMediaPlaybackSource(source, mimeType, fileName);
    try {
        try {
            await MediaLibrary.saveToLibraryAsync(staged.uri);
            return 'saved';
        } catch (saveError) {
            // Older Android packages may deliberately omit storage permissions.
            // The system share sheet can still export our own staged file.
            if (!await Sharing.isAvailableAsync()) throw saveError;
            await Sharing.shareAsync(staged.uri, { dialogTitle: fileName, mimeType });
            return 'shared';
        }
    } finally {
        if (staged !== source) await staged.release?.();
    }
}
