import { describe, expect, it } from 'vitest';
import {
    executeImageBatchDownload,
    prepareImageBatchDownloadItems,
    type ImageBatchDownloadProgress,
} from './imageBatchDownloadCore';

describe('prepareImageBatchDownloadItems', () => {
    it('prefixes every sanitized filename with its one-based ordinal', () => {
        const items = prepareImageBatchDownloadItems([
            { id: 'a', uri: 'data:image/png;base64,AA==', filename: 'same.png' },
            { id: 'b', uri: 'data:image/png;base64,AQ==', filename: 'same.png' },
        ]);

        expect(items.map((item) => item.filename)).toEqual([
            '01-same.png',
            '02-same.png',
        ]);
        expect(prepareImageBatchDownloadItems([
            { id: 'unsafe', uri: 'data:image/jpeg;base64,/9g=', filename: 'folder:preview?' },
        ])[0]?.filename).toBe('01-folder_preview_.jpg');
    });

    it('preserves an original batch ordinal when preparing a failed-subset retry', () => {
        const [retriedItem] = prepareImageBatchDownloadItems([
            {
                id: 'generated-56',
                uri: 'data:image/png;base64,AA==',
                filename: 'generated-56.png',
                ordinal: 56,
            },
        ]);

        expect(retriedItem?.filename).toBe('56-generated-56.png');
    });
});

describe('executeImageBatchDownload', () => {
    it('continues after an item failure and reports progress after every item', async () => {
        const items = prepareImageBatchDownloadItems([
            { id: 'a', uri: 'data:image/png;base64,AA==', filename: 'same.png' },
            { id: 'b', uri: 'data:image/png;base64,AQ==', filename: 'same.png' },
        ]);
        const progress: ImageBatchDownloadProgress[] = [];
        let sessionOpenCount = 0;

        const result = await executeImageBatchDownload(items, async () => {
            sessionOpenCount += 1;
            return {
                destination: 'browser',
                write: async (item) => {
                    if (item.id === 'a') throw new Error('first failed');
                },
            };
        }, { onProgress: (value) => progress.push(value) });

        expect(result.succeeded).toEqual(['b']);
        expect(result.failed.map((entry) => entry.id)).toEqual(['a']);
        expect(progress.map((entry) => entry.completed)).toEqual([1, 2]);
        expect(progress).toEqual([
            { completed: 1, total: 2, succeeded: 0, failed: 1, currentId: 'a' },
            { completed: 2, total: 2, succeeded: 1, failed: 1, currentId: 'b' },
        ]);
        expect(result.cancelled).toBe(false);
        expect(result.destination).toBe('browser');
        expect(sessionOpenCount).toBe(1);
    });

    it('returns a clean cancellation when no download session is created', async () => {
        const items = prepareImageBatchDownloadItems([
            { id: 'a', uri: 'data:image/png;base64,AA==' },
        ]);
        const progress: ImageBatchDownloadProgress[] = [];

        const result = await executeImageBatchDownload(
            items,
            async () => null,
            { onProgress: (value) => progress.push(value) },
        );

        expect(result).toEqual({
            succeeded: [],
            failed: [],
            cancelled: true,
            destination: 'unsupported',
        });
        expect(progress).toEqual([]);
    });

    it('allows a second call to retry only the prior failed item', async () => {
        const items = prepareImageBatchDownloadItems([
            { id: 'a', uri: 'data:image/png;base64,AA==' },
            { id: 'b', uri: 'data:image/png;base64,AQ==' },
        ]);
        const firstResult = await executeImageBatchDownload(items, async () => ({
            destination: 'directory',
            write: async (item) => {
                if (item.id === 'a') throw new Error('temporary failure');
            },
        }));
        const failedIds = new Set(firstResult.failed.map((entry) => entry.id));
        const retryItems = items.filter((item) => failedIds.has(item.id));
        const retriedIds: string[] = [];

        const retryResult = await executeImageBatchDownload(retryItems, async () => ({
            destination: 'directory',
            write: async (item) => {
                retriedIds.push(item.id);
            },
        }));

        expect(retriedIds).toEqual(['a']);
        expect(retryResult.succeeded).toEqual(['a']);
        expect(retryResult.failed).toEqual([]);
    });

    it('normalizes non-Error failures', async () => {
        const items = prepareImageBatchDownloadItems([
            { id: 'a', uri: 'data:image/png;base64,AA==' },
        ]);

        const result = await executeImageBatchDownload(items, async () => ({
            destination: 'photos',
            write: async () => {
                throw 'permission denied';
            },
        }));

        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]?.error).toEqual(new Error('permission denied'));
    });
});
