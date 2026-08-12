import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadOriginalAttachment } from './downloadOriginalAttachment.web';

describe('downloadOriginalAttachment on web', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('downloads the complete staged blob with the original filename', async () => {
        const click = vi.fn();
        const remove = vi.fn();
        const anchor = { href: '', download: '', rel: '', style: {}, click, remove };
        const appendChild = vi.fn();
        vi.stubGlobal('document', {
            createElement: vi.fn(() => anchor),
            body: { appendChild },
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            new Blob(['jpeg-and-mp4'], { type: 'image/jpeg' }),
            { status: 200 },
        ));
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:motion-download');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

        await expect(downloadOriginalAttachment(
            'blob:decrypted-motion-photo',
            'holiday.jpg',
            'image/jpeg',
        )).resolves.toBe(true);

        expect(anchor).toMatchObject({
            href: 'blob:motion-download',
            download: 'holiday.jpg',
            rel: 'noopener',
        });
        expect(appendChild).toHaveBeenCalledWith(anchor);
        expect(click).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledOnce();
    });

    it('rejects a failed staged-file read instead of downloading an error body', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing', { status: 404 }));

        await expect(downloadOriginalAttachment(
            'blob:missing',
            'holiday.jpg',
            'image/jpeg',
        )).rejects.toThrow('Original attachment download failed: 404');
    });
});
