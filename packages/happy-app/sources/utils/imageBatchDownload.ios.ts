import { Asset, requestPermissionsAsync } from 'expo-media-library/next';
import {
    executeImageBatchDownload,
    prepareImageBatchDownloadItems,
    type ImageBatchDownloadItem,
    type ImageBatchDownloadProgress,
    type ImageBatchDownloadResult,
} from './imageBatchDownloadCore';
import { stageImageForDownload } from './imageDownload';

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
        const permission = await requestPermissionsAsync(true, ['photo']);
        if (!permission.granted) return null;

        return {
            destination: 'photos',
            write: async (item) => {
                const localUri = await stageImageForDownload(item);
                await Asset.create(localUri);
            },
        };
    }, options);

    return result.cancelled ? { ...result, destination: 'photos' } : result;
}
