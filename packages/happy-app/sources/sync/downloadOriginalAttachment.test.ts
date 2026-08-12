import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sharing from 'expo-sharing';
import { downloadOriginalAttachment } from './downloadOriginalAttachment';

vi.mock('expo-sharing', () => ({
    isAvailableAsync: vi.fn(),
    shareAsync: vi.fn(),
}));

describe('downloadOriginalAttachment on native', () => {
    beforeEach(() => vi.clearAllMocks());

    it('opens the system save/share sheet with the original JPEG identity', async () => {
        vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
        vi.mocked(Sharing.shareAsync).mockResolvedValue(undefined);

        await expect(downloadOriginalAttachment(
            'file:///cache/holiday.jpg',
            'holiday.jpg',
            'image/jpeg',
        )).resolves.toBe(true);

        expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/holiday.jpg', {
            dialogTitle: 'holiday.jpg',
            mimeType: 'image/jpeg',
        });
    });

    it('fails clearly when the platform has no save/share support', async () => {
        vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(false);

        await expect(downloadOriginalAttachment(
            'file:///cache/holiday.jpg',
            'holiday.jpg',
            'image/jpeg',
        )).rejects.toThrow('Original attachment sharing is unavailable');
        expect(Sharing.shareAsync).not.toHaveBeenCalled();
    });
});
