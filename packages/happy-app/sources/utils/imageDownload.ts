import {
    cacheDirectory,
    copyAsync,
    deleteAsync,
    downloadAsync,
    EncodingType,
    getInfoAsync,
    makeDirectoryAsync,
    writeAsStringAsync,
} from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import {
    getImageDownloadFileName,
    getImageDownloadMimeType,
    parseDataUri,
    type ImageDownloadSource,
} from './imageDownloadCore';

export type DownloadImageOptions = {
    dialogTitle?: string;
};

export async function downloadImage(source: ImageDownloadSource, options: DownloadImageOptions = {}): Promise<string> {
    const targetUri = await stageImageForDownload(source);
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
        await Sharing.shareAsync(targetUri, {
            dialogTitle: options.dialogTitle,
            mimeType: getImageDownloadMimeType(source),
        });
    }
    return targetUri;
}

export async function stageImageForDownload(source: ImageDownloadSource): Promise<string> {
    if (!cacheDirectory) {
        throw new Error('Cache directory is unavailable on this platform.');
    }

    const dir = `${cacheDirectory}happy-downloads/`;
    const info = await getInfoAsync(dir);
    if (!info.exists) {
        await makeDirectoryAsync(dir, { intermediates: true });
    }

    const targetUri = `${dir}${getImageDownloadFileName(source)}`;
    await deleteAsync(targetUri, { idempotent: true });

    if (source.uri.startsWith('file://')) {
        await copyAsync({ from: source.uri, to: targetUri });
        return targetUri;
    }

    if (/^https?:\/\//i.test(source.uri)) {
        const result = await downloadAsync(source.uri, targetUri);
        return result.uri;
    }

    const dataUri = parseDataUri(source.uri);
    if (dataUri) {
        if (!dataUri.isBase64) {
            throw new Error('Only base64 data image URLs can be downloaded on this platform.');
        }
        await writeAsStringAsync(targetUri, dataUri.data, { encoding: EncodingType.Base64 });
        return targetUri;
    }

    throw new Error('This image URL type cannot be downloaded on this platform.');
}
