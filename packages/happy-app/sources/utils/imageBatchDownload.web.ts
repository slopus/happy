import { downloadImage } from './imageDownload';
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
        destination: 'browser',
        write: async (item) => {
            await downloadImage(item);
            // Chrome can silently drop later downloads in a large automatic
            // batch when anchor clicks arrive faster than it processes them.
            await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
        },
    }), options);
}
