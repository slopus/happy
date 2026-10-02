import { describe, expect, it, vi } from 'vitest';
import { createCodexSteerHandler, decodeCodexSteerImages } from './codexSteerRpc';

vi.mock('./codexImageInput', async (importOriginal) => ({
    ...await importOriginal<typeof import('./codexImageInput')>(),
    materializeCodexImageItems: (attachments: unknown[]) => attachments.map((_, index) => ({ type: 'localImage', path: `/tmp/steer-test-image-${index}.png` })),
}));

const request = { text: 'Focus on the tests first', expectedTurnId: 'turn-1', clientMessageId: 'message-1' };

describe('Codex steer RPC', () => {
    it('waits for native acceptance, records one user message and deduplicates retries', async () => {
        let accept!: (result: { turnId: string }) => void;
        const steerTurn = vi.fn(() => new Promise<{ turnId: string }>((resolve) => { accept = resolve; }));
        const sendMessage = vi.fn();
        const handler = createCodexSteerHandler({ client: { steerTurn }, sendMessage });
        const first = handler(request);
        const retry = handler(request);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(steerTurn).toHaveBeenCalledTimes(1);
        accept({ turnId: 'turn-1' });
        await expect(first).resolves.toEqual({ accepted: true, turnId: 'turn-1', clientMessageId: 'message-1' });
        await retry;
        await handler(request);
        expect(steerTurn).toHaveBeenCalledWith(request.text, 'turn-1', [], 'message-1');
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0][0]).toMatchObject({
            id: 'codex-steer:message-1', role: 'user', turn: 'turn-1', ev: { t: 'text', text: request.text },
        });
    });

    it('propagates native rejection without creating history or pretending acceptance', async () => {
        const steerTurn = vi.fn().mockRejectedValue(new Error('active turn changed'));
        const sendMessage = vi.fn();
        const handler = createCodexSteerHandler({ client: { steerTurn }, sendMessage });
        await expect(handler(request)).rejects.toThrow('active turn changed');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('rejects reuse of a confirmed message ID with another input', async () => {
        const handler = createCodexSteerHandler({ client: { steerTurn: vi.fn().mockResolvedValue({ turnId: 'turn-1' }) }, sendMessage: vi.fn() });
        await handler(request);
        await expect(handler({ ...request, text: 'Another task' })).rejects.toThrow('different input');
    });

    it('rejects invalid and unsupported images before native submission', async () => {
        const steerTurn = vi.fn();
        const handler = createCodexSteerHandler({ client: { steerTurn }, sendMessage: vi.fn() });
        for (const data of ['not base64', Buffer.from('not an image').toString('base64'), '']) {
            await expect(handler({ ...request, images: [{ data }] })).rejects.toThrow();
        }
        expect(steerTurn).not.toHaveBeenCalled();
        expect(() => decodeCodexSteerImages(Array.from({ length: 11 }, () => ({ data: 'aGVsbG8=' })))).toThrow('At most 10');
        expect(() => decodeCodexSteerImages([{ data: 'A'.repeat(28 * 1024 * 1024) }])).toThrow('oversized');
    });

    it('uploads images before native submission and persists stable encrypted refs only after acceptance', async () => {
        const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
        const imageRequest = { ...request, images: [{ data, name: 'visual.png' }] };
        let finishUpload!: (value: any) => void;
        let accept!: (value: any) => void;
        const uploadImageAttachment = vi.fn(() => new Promise<any>((resolve) => { finishUpload = resolve; }));
        const steerTurn = vi.fn(() => new Promise<{ turnId: string }>((resolve) => { accept = resolve; }));
        const sendMessage = vi.fn();
        const handler = createCodexSteerHandler({ client: { steerTurn }, sendMessage, uploadImageAttachment });
        const first = handler(imageRequest);
        const retry = handler(imageRequest);
        expect(uploadImageAttachment).toHaveBeenCalledExactlyOnceWith('/tmp/steer-test-image-0.png');
        expect(steerTurn).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        finishUpload({ ref: 'encrypted-image-ref', name: 'visual.png', size: 4, dims: { width: 640, height: 480 }, motionPhoto: null });
        await vi.waitFor(() => expect(steerTurn).toHaveBeenCalledTimes(1));
        expect(sendMessage).not.toHaveBeenCalled();
        accept({ turnId: 'turn-1' });
        await first;
        await retry;
        await handler(imageRequest);
        expect(uploadImageAttachment).toHaveBeenCalledTimes(1);
        expect(steerTurn).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(sendMessage.mock.calls[0][0]).toMatchObject({
            id: 'codex-steer:message-1:image:0', role: 'user', turn: 'turn-1',
            ev: { t: 'file', ref: 'encrypted-image-ref', name: 'visual.png', size: 4,
                source: 'user', encrypted: true, image: { width: 640, height: 480, thumbhash: '' } },
        });
        expect(sendMessage.mock.calls[1][0]).toMatchObject({
            id: 'codex-steer:message-1', role: 'user', turn: 'turn-1', ev: { t: 'text', text: request.text },
        });
    });

    it('does not submit native steering or history if image upload fails', async () => {
        const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
        const steerTurn = vi.fn();
        const sendMessage = vi.fn();
        const uploadImageAttachment = vi.fn().mockRejectedValue(new Error('attachment upload failed'));
        const handler = createCodexSteerHandler({ client: { steerTurn }, sendMessage, uploadImageAttachment });
        await expect(handler({ ...request, images: [{ data }] })).rejects.toThrow('attachment upload failed');
        expect(steerTurn).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('does not publish uploaded refs if the active turn changed during upload', async () => {
        const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
        const steerTurn = vi.fn().mockRejectedValue(new Error('active turn changed'));
        const sendMessage = vi.fn();
        const uploadImageAttachment = vi.fn().mockResolvedValue({ ref: 'ref', name: 'image.png', size: 4, dims: null, motionPhoto: null });
        const handler = createCodexSteerHandler({ client: { steerTurn }, sendMessage, uploadImageAttachment });
        await expect(handler({ ...request, images: [{ data }] })).rejects.toThrow('active turn changed');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('sniffs the supported image type rather than trusting the claimed MIME', () => {
        const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
        expect(decodeCodexSteerImages([{ data, mimeType: 'image/heic' }])[0].mimeType).toBe('image/png');
    });
});
