import {
    getImageDownloadFileName,
    type ImageDownloadSource,
} from './imageDownloadCore';

export type ImageBatchDownloadItem = ImageDownloadSource & { id: string; ordinal?: number };
export type PreparedImageBatchDownloadItem = ImageBatchDownloadItem & { filename: string; ordinal: number };
export type ImageBatchDownloadDestination = 'browser' | 'directory' | 'photos' | 'unsupported';
export type ImageBatchDownloadProgress = {
    completed: number;
    total: number;
    succeeded: number;
    failed: number;
    currentId: string;
};
export type ImageBatchDownloadResult = {
    succeeded: string[];
    failed: Array<{ id: string; error: Error }>;
    cancelled: boolean;
    destination: ImageBatchDownloadDestination;
};
export type ImageBatchDownloadSession = {
    destination: ImageBatchDownloadDestination;
    write(item: PreparedImageBatchDownloadItem): Promise<void>;
};

export function prepareImageBatchDownloadItems(
    items: readonly ImageBatchDownloadItem[],
): PreparedImageBatchDownloadItem[] {
    return items.map((item, index) => {
        const ordinal = item.ordinal ?? index + 1;
        return {
            ...item,
            ordinal,
            filename: `${String(ordinal).padStart(2, '0')}-${getImageDownloadFileName(item)}`,
        };
    });
}

export async function executeImageBatchDownload(
    items: readonly PreparedImageBatchDownloadItem[],
    createSession: () => Promise<ImageBatchDownloadSession | null>,
    options: { onProgress?: (progress: ImageBatchDownloadProgress) => void } = {},
): Promise<ImageBatchDownloadResult> {
    const session = await createSession();
    if (!session) {
        return {
            succeeded: [],
            failed: [],
            cancelled: true,
            destination: 'unsupported',
        };
    }

    const succeeded: string[] = [];
    const failed: Array<{ id: string; error: Error }> = [];

    for (const item of items) {
        try {
            await session.write(item);
            succeeded.push(item.id);
        } catch (error) {
            failed.push({
                id: item.id,
                error: error instanceof Error ? error : new Error(String(error)),
            });
        }

        options.onProgress?.({
            completed: succeeded.length + failed.length,
            total: items.length,
            succeeded: succeeded.length,
            failed: failed.length,
            currentId: item.id,
        });
    }

    return {
        succeeded,
        failed,
        cancelled: false,
        destination: session.destination,
    };
}
