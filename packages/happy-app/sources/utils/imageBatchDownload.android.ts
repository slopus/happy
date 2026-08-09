import {
    EncodingType,
    readAsStringAsync,
    StorageAccessFramework,
} from 'expo-file-system/legacy';
import {
    executeImageBatchDownload,
    prepareImageBatchDownloadItems,
    type ImageBatchDownloadItem,
    type ImageBatchDownloadProgress,
    type ImageBatchDownloadResult,
} from './imageBatchDownloadCore';
import { stageImageForDownload } from './imageDownload';
import { getImageDownloadMimeType } from './imageDownloadCore';

export type {
    ImageBatchDownloadDestination,
    ImageBatchDownloadItem,
    ImageBatchDownloadProgress,
    ImageBatchDownloadResult,
} from './imageBatchDownloadCore';

export async function downloadImageBatch(
    items: ImageBatchDownloadItem[],
    options?: { onProgress?: (progress: ImageBatchDownloadProgress) => void },
): Promise<ImageBatchDownloadResult> {
    const preparedItems = prepareImageBatchDownloadItems(items);
    const result = await executeImageBatchDownload(preparedItems, async () => {
        const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!permission.granted) return null;

        return {
            destination: 'directory',
            write: async (item) => {
                const localUri = await stageImageForDownload(item);
                const base64 = await readAsStringAsync(localUri, { encoding: EncodingType.Base64 });
                const contentUri = await StorageAccessFramework.createFileAsync(
                    permission.directoryUri,
                    item.filename,
                    getImageDownloadMimeType(item),
                );
                await StorageAccessFramework.writeAsStringAsync(contentUri, base64, {
                    encoding: EncodingType.Base64,
                });
            },
        };
    }, options);

    return result.cancelled ? { ...result, destination: 'directory' } : result;
}
