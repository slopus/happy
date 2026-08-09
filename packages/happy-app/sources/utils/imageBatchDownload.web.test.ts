import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const downloadImageMock = vi.hoisted(() => vi.fn());

vi.mock('./imageDownload', () => ({
    downloadImage: downloadImageMock,
}));

import { downloadImageBatch } from './imageBatchDownload.web';
import { downloadImageBatch as downloadUnsupportedImageBatch } from './imageBatchDownload';

describe('downloadImageBatch on web', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetAllMocks();
        vi.stubGlobal('window', { setTimeout });
        downloadImageMock.mockResolvedValue('downloaded');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('downloads prepared filenames sequentially in source order', async () => {
        let releaseFirstDownload!: () => void;
        downloadImageMock
            .mockImplementationOnce(() => new Promise<string>((resolve) => {
                releaseFirstDownload = () => resolve('downloaded');
            }))
            .mockResolvedValueOnce('downloaded');

        const resultPromise = downloadImageBatch([
            { id: 'a', uri: 'data:image/png;base64,AA==', filename: 'a.png' },
            { id: 'b', uri: 'data:image/png;base64,AQ==', filename: 'b.png' },
        ]);

        await Promise.resolve();
        expect(downloadImageMock.mock.calls[0]?.[0].filename).toBe('01-a.png');

        releaseFirstDownload();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(99);
        expect(downloadImageMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(downloadImageMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(100);
        const result = await resultPromise;

        expect(downloadImageMock.mock.calls.map(([item]) => item.filename)).toEqual([
            '01-a.png',
            '02-b.png',
        ]);
        expect(result).toMatchObject({
            succeeded: ['a', 'b'],
            failed: [],
            cancelled: false,
            destination: 'browser',
        });
    });

    it('reports unsupported-platform writes as item failures', async () => {
        const result = await downloadUnsupportedImageBatch([
            { id: 'a', uri: 'data:image/png;base64,AA==', filename: 'a.png' },
        ]);

        expect(result).toMatchObject({
            succeeded: [],
            cancelled: false,
            destination: 'unsupported',
        });
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]?.id).toBe('a');
    });
});
