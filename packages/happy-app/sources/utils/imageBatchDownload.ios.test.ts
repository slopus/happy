import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaLibraryMock = vi.hoisted(() => ({
    requestPermissionsAsync: vi.fn(),
    Asset: { create: vi.fn() },
}));

const stageImageForDownloadMock = vi.hoisted(() => vi.fn());

vi.mock('expo-media-library/next', () => mediaLibraryMock);

vi.mock('./imageDownload', () => ({
    stageImageForDownload: stageImageForDownloadMock,
}));

import { downloadImageBatch } from './imageBatchDownload.ios';

describe('downloadImageBatch on iOS', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mediaLibraryMock.requestPermissionsAsync.mockResolvedValue({ granted: true });
        stageImageForDownloadMock
            .mockResolvedValueOnce('file:///cache/01-a.png')
            .mockResolvedValueOnce('file:///cache/02-b.png');
        mediaLibraryMock.Asset.create.mockResolvedValue({ id: 'asset' });
    });

    it('asks once for add-only photo permission and inserts every staged image', async () => {
        const result = await downloadImageBatch([
            { id: 'a', uri: 'data:image/png;base64,AA==', filename: 'a.png' },
            { id: 'b', uri: 'data:image/png;base64,AQ==', filename: 'b.png' },
        ]);

        expect(mediaLibraryMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);
        expect(mediaLibraryMock.requestPermissionsAsync).toHaveBeenCalledWith(true, ['photo']);
        expect(stageImageForDownloadMock.mock.calls.map(([item]) => item.filename)).toEqual([
            '01-a.png',
            '02-b.png',
        ]);
        expect(mediaLibraryMock.Asset.create.mock.calls).toEqual([
            ['file:///cache/01-a.png'],
            ['file:///cache/02-b.png'],
        ]);
        expect(result).toMatchObject({
            succeeded: ['a', 'b'],
            failed: [],
            cancelled: false,
            destination: 'photos',
        });
    });

    it('returns photo cancellation without staging or inserting when access is denied', async () => {
        mediaLibraryMock.requestPermissionsAsync.mockResolvedValue({ granted: false });

        const result = await downloadImageBatch([
            { id: 'a', uri: 'data:image/png;base64,AA==', filename: 'a.png' },
        ]);

        expect(result).toMatchObject({ cancelled: true, destination: 'photos' });
        expect(stageImageForDownloadMock).not.toHaveBeenCalled();
        expect(mediaLibraryMock.Asset.create).not.toHaveBeenCalled();
    });
});
