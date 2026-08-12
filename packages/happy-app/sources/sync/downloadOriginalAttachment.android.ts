import {
    EncodingType,
    readAsStringAsync,
    StorageAccessFramework,
} from 'expo-file-system/legacy';
import { getImageDownloadFileName } from '@/utils/imageDownloadCore';

/** Preserve every original byte by copying the staged file through Android's directory picker. */
export async function downloadOriginalAttachment(
    uri: string,
    fileName: string,
    mimeType: string,
): Promise<boolean> {
    const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permission.granted) return false;

    const safeFileName = getImageDownloadFileName({ uri, filename: fileName });
    const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
    const destination = await StorageAccessFramework.createFileAsync(
        permission.directoryUri,
        safeFileName,
        mimeType,
    );
    await StorageAccessFramework.writeAsStringAsync(destination, base64, {
        encoding: EncodingType.Base64,
    });
    return true;
}
