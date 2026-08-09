import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAttachmentImageSource } from './attachmentImageSource.web';

describe('web attachment image thumbnails', () => {
    const bitmap = { close: vi.fn() };
    const context = { drawImage: vi.fn() };
    const canvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => context),
        toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
            callback(new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/webp' }));
        }),
    };

    beforeEach(() => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
        vi.stubGlobal('document', {
            createElement: vi.fn(() => canvas),
        });
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:attachment-thumbnail');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        bitmap.close.mockClear();
        context.drawImage.mockClear();
        canvas.getContext.mockClear();
        canvas.toBlob.mockClear();
        canvas.width = 0;
        canvas.height = 0;
    });

    it('decodes a 4K attachment at thumbnail dimensions and releases its object URL', async () => {
        const source = await createAttachmentImageSource(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            'image/png',
            {
                maxDimension: 1024,
                sourceWidth: 3840,
                sourceHeight: 2560,
            },
        );

        expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
            resizeWidth: 1024,
            resizeHeight: 683,
            resizeQuality: 'high',
        });
        expect(canvas.width).toBe(1024);
        expect(canvas.height).toBe(683);
        expect(source).toMatchObject({
            uri: 'blob:attachment-thumbnail',
            byteSize: 4,
        });

        source.dispose();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:attachment-thumbnail');
        expect(bitmap.close).toHaveBeenCalledOnce();
    });
});
