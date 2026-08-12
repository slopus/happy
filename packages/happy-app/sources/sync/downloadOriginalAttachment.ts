import * as Sharing from 'expo-sharing';
import { getImageDownloadFileName } from '@/utils/imageDownloadCore';

/** Open the native save/share sheet for an original attachment staged on disk. */
export async function downloadOriginalAttachment(
    uri: string,
    fileName: string,
    mimeType: string,
): Promise<boolean> {
    if (!await Sharing.isAvailableAsync()) {
        throw new Error('Original attachment sharing is unavailable');
    }
    const safeFileName = getImageDownloadFileName({ uri, filename: fileName });
    await Sharing.shareAsync(uri, {
        dialogTitle: safeFileName,
        mimeType,
    });
    return true;
}
