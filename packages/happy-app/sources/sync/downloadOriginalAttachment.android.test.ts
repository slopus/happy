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

vi.mock('expo-file-system/legacy', () => fileSystemMock);

import { downloadOriginalAttachment } from './downloadOriginalAttachment.android';

describe('downloadOriginalAttachment on Android', () => {
    beforeEach(() => vi.clearAllMocks());

    it('writes the exact staged bytes to the user-selected directory', async () => {
        fileSystemMock.StorageAccessFramework.requestDirectoryPermissionsAsync.mockResolvedValue({
            granted: true,
            directoryUri: 'content://downloads',
        });
        fileSystemMock.readAsStringAsync.mockResolvedValue('FULL_JPEG_AND_MP4_BASE64');
        fileSystemMock.StorageAccessFramework.createFileAsync.mockResolvedValue('content://downloads/holiday');
        fileSystemMock.StorageAccessFramework.writeAsStringAsync.mockResolvedValue(undefined);

        await expect(downloadOriginalAttachment(
            'file:///cache/holiday.jpg',
            'holiday.jpg',
            'image/jpeg',
        )).resolves.toBe(true);

        expect(fileSystemMock.readAsStringAsync).toHaveBeenCalledWith(
            'file:///cache/holiday.jpg',
            { encoding: 'base64' },
        );
        expect(fileSystemMock.StorageAccessFramework.createFileAsync).toHaveBeenCalledWith(
            'content://downloads',
            'holiday.jpg',
            'image/jpeg',
        );
        expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).toHaveBeenCalledWith(
            'content://downloads/holiday',
            'FULL_JPEG_AND_MP4_BASE64',
            { encoding: 'base64' },
        );
    });

    it('treats directory-picker cancellation as a cancelled download', async () => {
        fileSystemMock.StorageAccessFramework.requestDirectoryPermissionsAsync.mockResolvedValue({
            granted: false,
        });

        await expect(downloadOriginalAttachment(
            'file:///cache/holiday.jpg',
            'holiday.jpg',
            'image/jpeg',
        )).resolves.toBe(false);
        expect(fileSystemMock.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
    });
});
