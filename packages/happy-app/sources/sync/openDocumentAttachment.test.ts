import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sharing from 'expo-sharing';
import { openDocumentAttachment } from './openDocumentAttachment';

vi.mock('expo-sharing', () => ({
    isAvailableAsync: vi.fn(),
    shareAsync: vi.fn(),
}));

describe('openDocumentAttachment on native', () => {
    beforeEach(() => vi.clearAllMocks());

    it('shares the staged PDF with its original filename and MIME type', async () => {
        vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
        vi.mocked(Sharing.shareAsync).mockResolvedValue(undefined);

        await openDocumentAttachment('file:///cache/unique/floor-plan.pdf', 'floor-plan.pdf', 'application/pdf');

        expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/unique/floor-plan.pdf', {
            dialogTitle: 'floor-plan.pdf',
            mimeType: 'application/pdf',
        });
    });

    it('fails clearly when the platform has no document sharing support', async () => {
        vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(false);

        await expect(openDocumentAttachment(
            'file:///cache/unique/floor-plan.pdf',
            'floor-plan.pdf',
            'application/pdf',
        )).rejects.toThrow('Document sharing is unavailable');
        expect(Sharing.shareAsync).not.toHaveBeenCalled();
    });
});
