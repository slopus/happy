import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaPlaybackSource, downloadMediaPlaybackSource } from './createMediaPlaybackSource.web';

describe('web media attachment sources', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('turns decrypted PDF bytes into a revocable browser object URL', async () => {
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:decrypted-pdf');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

        const source = await createMediaPlaybackSource(
            new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            'application/pdf',
            'floor-plan.pdf',
        );

        expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
        expect(source.uri).toBe('blob:decrypted-pdf');
        await source.release?.();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:decrypted-pdf');
    });

    it('downloads authenticated generated files into an object URL', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            new Blob(['pdf'], { type: 'application/pdf' }),
            { status: 200 },
        ));
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:downloaded-pdf');

        const source = await downloadMediaPlaybackSource({
            uri: 'https://files.test/plan.pdf',
            headers: { Authorization: 'Bearer token' },
        }, 'application/pdf', 'plan.pdf');

        expect(fetch).toHaveBeenCalledWith('https://files.test/plan.pdf', {
            headers: { Authorization: 'Bearer token' },
        });
        expect(source.uri).toBe('blob:downloaded-pdf');
    });
});
