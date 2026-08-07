import * as Sharing from 'expo-sharing';

/** Hand a staged native document to the operating-system share/open sheet. */
export async function openDocumentAttachment(uri: string, fileName: string, mimeType: string): Promise<void> {
    if (!await Sharing.isAvailableAsync()) {
        throw new Error('Document sharing is unavailable');
    }
    await Sharing.shareAsync(uri, {
        dialogTitle: fileName,
        mimeType,
    });
}
