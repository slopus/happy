// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveVideoAttachment } from './saveVideoAttachment.web';

describe('browser video saving', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('downloads authenticated video bytes as the original MP4 filename and revokes the temporary URL', async () => {
        const blob = new Blob(['mp4 bytes'], { type: 'video/mp4' });
        const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
        const createObjectURL = vi.fn().mockReturnValue('blob:download');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('fetch', fetch);
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        let fileName: string | undefined;
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            fileName = this.download;
            expect(this.href).toBe('blob:download');
            expect(this.isConnected).toBe(true);
        });
        await expect(saveVideoAttachment({ uri: 'https://media.test/clip', headers: { Authorization: 'test-only' } }, '成片.mp4', 'video/mp4')).resolves.toBe('downloaded');
        expect(fetch).toHaveBeenCalledWith('https://media.test/clip', expect.objectContaining({ headers: { Authorization: 'test-only' }, signal: expect.anything() }));
        expect(fileName).toBe('成片.mp4');
        expect(click).toHaveBeenCalledOnce();
        expect(createObjectURL).toHaveBeenCalledWith(blob);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:download');
        expect(document.querySelector('a')).toBeNull();
    });

    it('does not export stale private media after the account context changes during download', async () => {
        let current = true;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => { current = false; return new Blob(['video']); } }));
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
        await expect(saveVideoAttachment({ uri: 'https://media.test/clip', headers: {}, isCurrent: () => current }, 'clip.mp4', 'video/mp4')).rejects.toThrow('no longer available');
        expect(click).not.toHaveBeenCalled();
    });

    it('reports an HTTP download failure without clicking a download link', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
        await expect(saveVideoAttachment({ uri: 'https://media.test/clip', headers: {} }, 'clip.mp4', 'video/mp4')).rejects.toThrow('401');
        expect(click).not.toHaveBeenCalled();
    });

    it('times out a stalled browser fetch and aborts it instead of reporting a download', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn().mockReturnValue(new Promise(() => {}));
        vi.stubGlobal('fetch', fetch);
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
        const pending = saveVideoAttachment({ uri: 'https://media.test/stall', headers: {} }, 'clip.mp4', 'video/mp4', { stallTimeoutMs: 1000 }).catch(error => error);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await pending).toMatchObject({ name: 'AttachmentTransferTimeoutError' });
        expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
        expect(click).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledOnce();
    });
});
