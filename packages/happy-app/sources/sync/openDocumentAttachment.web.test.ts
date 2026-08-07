import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDocumentAttachment } from './openDocumentAttachment.web';

describe('openDocumentAttachment on web', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('downloads a decrypted PDF with its original filename when file sharing is unavailable', async () => {
        const click = vi.fn();
        const remove = vi.fn();
        const anchor = { href: '', download: '', rel: '', click, remove };
        vi.stubGlobal('navigator', { canShare: () => false });
        vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            new Blob(['pdf'], { type: 'application/pdf' }),
            { status: 200 },
        ));
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:web-download');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

        await openDocumentAttachment('blob:decrypted-pdf', 'floor-plan.pdf', 'application/pdf');

        expect(anchor).toMatchObject({
            href: 'blob:web-download',
            download: 'floor-plan.pdf',
            rel: 'noopener',
        });
        expect(click).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledOnce();
    });

    it('falls back to a named download when Web Share loses user activation', async () => {
        const click = vi.fn();
        const anchor = { href: '', download: '', rel: '', click, remove: vi.fn() };
        const share = vi.fn(async () => {
            throw new DOMException('Activation expired', 'NotAllowedError');
        });
        vi.stubGlobal('File', class MockFile {
            constructor(_parts: BlobPart[], _name: string, _options: FilePropertyBag) {}
        });
        vi.stubGlobal('navigator', { canShare: () => true, share });
        vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            new Blob(['pdf'], { type: 'application/pdf' }),
            { status: 200 },
        ));
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:web-fallback');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

        await openDocumentAttachment('blob:decrypted-pdf', 'floor-plan.pdf', 'application/pdf');

        expect(share).toHaveBeenCalledOnce();
        expect(anchor.download).toBe('floor-plan.pdf');
        expect(click).toHaveBeenCalledOnce();
    });
});
