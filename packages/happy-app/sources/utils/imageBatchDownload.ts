import {
    executeImageBatchDownload,
    prepareImageBatchDownloadItems,
    type ImageBatchDownloadItem,
    type ImageBatchDownloadProgress,
    type ImageBatchDownloadResult,
} from './imageBatchDownloadCore';

export type {
    ImageBatchDownloadDestination,
    ImageBatchDownloadItem,
    ImageBatchDownloadProgress,
    ImageBatchDownloadResult,
} from './imageBatchDownloadCore';

export function downloadImageBatch(
    items: ImageBatchDownloadItem[],
    options?: { onProgress?: (progress: ImageBatchDownloadProgress) => void },
): Promise<ImageBatchDownloadResult> {
    const preparedItems = prepareImageBatchDownloadItems(items);

    return executeImageBatchDownload(preparedItems, async () => ({
        destination: 'unsupported',
        write: async () => {
            throw new Error('Batch image downloads are unavailable on this platform.');
        },
    }), options);
}
