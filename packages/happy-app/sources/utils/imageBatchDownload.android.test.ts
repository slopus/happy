import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileSystemMock = vi.hoisted(() => ({
    EncodingType: { Base64: 'base64' },
    readAsStringAsync: vi.fn(),
    StorageAccessFramework: {
        requestDirectoryPermissionsAsync: vi.fn(),
        createFileAsync: vi.fn(),
        writeAsStringAsync: vi.fn(),
    },
}));

const stageImageForDownloadMock = vi.hoisted(() => vi.fn());

vi.mock('expo-file-system/legacy', () => fileSystemMock);

vi.mock('./imageDownload', () => ({
    stageImageForDownload: stageImageForDownloadMock,
}));

import { downloadImageBatch } from './imageBatchDownload.android';

describe('downloadImageBatch on Android', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        fileSystemMock.StorageAccessFramework.requestDirectoryPermissionsAsync.mockResolvedValue({
            granted: true,
            directoryUri: 'content://downloads',
        });
        stageImageForDownloadMock
            .mockResolvedValueOnce('file:///cache/01-a.png')
            .mockResolvedValueOnce('file:///cache/02-b.jpg');
        fileSystemMock.readAsStringAsync
            .mockResolvedValueOnce('BASE64_A')
            .mockResolvedValueOnce('BASE64_B');
        fileSystemMock.StorageAccessFramework.createFileAsync
            .mockResolvedValueOnce('content://downloads/a')
            .mockResolvedValueOnce('content://downloads/b');
        fileSystemMock.StorageAccessFramework.writeAsStringAsync.mockResolvedValue(undefined);
    });

    it('asks for one directory and writes every staged image to a distinct content URI', async () => {
        const result = await downloadImageBatch([
            { id: 'a', uri: 'data:image/png;base64,AA==', filename: 'a.png' },
            { id: 'b', uri: 'data:image/jpeg;base64,/9g=', filename: 'b.jpg' },
        ]);

        expect(fileSystemMock.StorageAccessFramework.requestDirectoryPermissionsAsync).toHaveBeenCalledTimes(1);
        expect(stageImageForDownloadMock.mock.calls.map(([item]) => item.filename)).toEqual([
            '01-a.png',
            '02-b.jpg',
        ]);
        expect(fileSystemMock.readAsStringAsync.mock.calls).toEqual([
            ['file:///cache/01-a.png', { encoding: 'base64' }],
            ['file:///cache/02-b.jpg', { encoding: 'base64' }],
        ]);
        expect(fileSystemMock.StorageAccessFramework.createFileAsync.mock.calls).toEqual([
            ['content://downloads', '01-a.png', 'image/png'],
            ['content://downloads', '02-b.jpg', 'image/jpeg'],
        ]);
        expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync.mock.calls).toEqual([
            ['content://downloads/a', 'BASE64_A', { encoding: 'base64' }],
            ['content://downloads/b', 'BASE64_B', { encoding: 'base64' }],
        ]);
        expect(result).toMatchObject({
            succeeded: ['a', 'b'],
            failed: [],
            cancelled: false,
            destination: 'directory',
        });
    });

    it('returns directory cancellation without writing when access is denied', async () => {
        fileSystemMock.StorageAccessFramework.requestDirectoryPermissionsAsync.mockResolvedValue({
            granted: false,
        });

        const result = await downloadImageBatch([
            { id: 'a', uri: 'data:image/png;base64,AA==', filename: 'a.png' },
        ]);

        expect(result).toMatchObject({ cancelled: true, destination: 'directory' });
        expect(stageImageForDownloadMock).not.toHaveBeenCalled();
        expect(fileSystemMock.readAsStringAsync).not.toHaveBeenCalled();
        expect(fileSystemMock.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
        expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).not.toHaveBeenCalled();
    });
});
