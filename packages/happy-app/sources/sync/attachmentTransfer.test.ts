import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentTransferTimeoutError, waitForAttachmentTransfer, withAttachmentDeadline } from './attachmentTransfer';

const { AbortController: NativeAbortController } = createRequire(import.meta.url)('abort-controller/dist/abort-controller');
afterEach(() => vi.useRealTimers());

describe('attachment transfer cancellation and deadlines', () => {
    it('cancels an ignored native operation using the actual RN AbortSignal without reason/throwIfAborted', async () => {
        const controller = new NativeAbortController();
        expect(controller.signal.throwIfAborted).toBeUndefined();
        const pending = waitForAttachmentTransfer(new Promise(() => {}), controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('preserves a browser cancellation reason, including null', async () => {
        const controller = new AbortController();
        const pending = waitForAttachmentTransfer(new Promise(() => {}), controller.signal);
        controller.abort(null);
        expect(await pending.catch(error => error)).toBeNull();
    });

    it('bounds a request that never resolves, aborts it and does not start another request', async () => {
        vi.useFakeTimers();
        let signal!: AbortSignal;
        const operation = vi.fn((value: AbortSignal) => { signal = value; return new Promise(() => {}); });
        const pending = withAttachmentDeadline(operation, 20_000);
        const result = pending.catch(error => error);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await result).toBeInstanceOf(AttachmentTransferTimeoutError);
        expect(signal.aborted).toBe(true);
        expect(operation).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});
