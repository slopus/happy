import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

import { downloadCodexFileEventAttachment } from './attachmentEvents';

function fileEvent(overrides?: Partial<{
    ref: string;
    name: string;
    size: number;
    mimeType: string | null;
}>) {
    return {
        content: {
            data: {
                ev: {
                    t: 'file',
                    ref: overrides?.ref ?? 'attachment-ref',
                    name: overrides?.name ?? 'image.png',
                    size: overrides?.size ?? 3,
                    mimeType: overrides && 'mimeType' in overrides ? overrides.mimeType : 'image/png',
                },
            },
        },
    } as any;
}

describe('downloadCodexFileEventAttachment', () => {
    it('downloads and returns a pending attachment payload', async () => {
        const data = new Uint8Array([1, 2, 3]);
        const session = {
            downloadAndDecryptAttachment: vi.fn().mockResolvedValue(data),
        };

        await expect(downloadCodexFileEventAttachment(session, fileEvent())).resolves.toEqual({
            data,
            mimeType: 'image/png',
            name: 'image.png',
        });
        expect(session.downloadAndDecryptAttachment).toHaveBeenCalledWith('attachment-ref');
    });

    it('defaults missing MIME type to image/jpeg', async () => {
        const data = new Uint8Array([1, 2, 3]);
        const session = {
            downloadAndDecryptAttachment: vi.fn().mockResolvedValue(data),
        };

        await expect(downloadCodexFileEventAttachment(session, fileEvent({ mimeType: null }))).resolves.toEqual({
            data,
            mimeType: 'image/jpeg',
            name: 'image.png',
        });
    });

    it('returns null when download or decrypt fails', async () => {
        const session = {
            downloadAndDecryptAttachment: vi.fn().mockRejectedValue(new Error('download failed')),
        };

        await expect(downloadCodexFileEventAttachment(session, fileEvent())).resolves.toBeNull();
    });

    it('returns null when decryption returns null', async () => {
        const session = {
            downloadAndDecryptAttachment: vi.fn().mockResolvedValue(null),
        };

        await expect(downloadCodexFileEventAttachment(session, fileEvent())).resolves.toBeNull();
    });
});
