import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { downloadMediaPlaybackSource } from './createMediaPlaybackSource';
import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';
import type { VideoSaveOptions, VideoSaveResult } from './saveVideoAttachment.types';
import { transferAbortReason, waitForAttachmentTransfer, withAttachmentDeadline } from './attachmentTransfer';

/** Save a local video without requesting access to the user's existing library. */
export async function saveVideoAttachment(
    source: MediaPlaybackSource,
    fileName: string,
    mimeType: string,
    options: VideoSaveOptions = {},
): Promise<VideoSaveResult> {
    if (options.signal?.aborted) throw transferAbortReason(options.signal);
    if (!source.uri.startsWith('file://')) options.onPhase?.('downloading');
    const staged = source.uri.startsWith('file://')
        ? source
        : await downloadMediaPlaybackSource(source, mimeType, fileName, options);
    const keepWhileNativeUses = <T,>(operation: () => Promise<T>): Promise<T> => {
        const lease = staged.retain?.();
        return Promise.resolve().then(operation).finally(() => lease?.release?.());
    };
    try {
        try {
            if (options.signal?.aborted) throw transferAbortReason(options.signal);
            options.onPhase?.('saving');
            await waitForAttachmentTransfer(withAttachmentDeadline(
                () => keepWhileNativeUses(() => MediaLibrary.saveToLibraryAsync(staged.uri)), 45_000), options.signal);
            return 'saved';
        } catch (saveError) {
            if (options.signal?.aborted) throw transferAbortReason(options.signal);
            // Older Android packages may deliberately omit storage permissions.
            // The system share sheet can still export our own staged file.
            if (!await Sharing.isAvailableAsync()) throw saveError;
            options.onPhase?.('sharing');
            await waitForAttachmentTransfer(keepWhileNativeUses(
                () => Sharing.shareAsync(staged.uri, { dialogTitle: fileName, mimeType })), options.signal);
            return 'shared';
        }
    } finally {
        if (staged !== source) await staged.release?.();
    }
}
