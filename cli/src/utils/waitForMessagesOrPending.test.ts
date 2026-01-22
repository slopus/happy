import { describe, it, expect } from 'vitest';
import { MessageQueue2 } from './MessageQueue2';
import { waitForMessagesOrPending } from './waitForMessagesOrPending';

describe('waitForMessagesOrPending', () => {
    it('returns immediately when a queue message exists', async () => {
        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };

        const queue = new MessageQueue2<Mode>(() => 'hash');
        queue.pushImmediate('hello', mode);

        const result = await waitForMessagesOrPending({
            messageQueue: queue,
            abortSignal: new AbortController().signal,
            popPendingMessage: async () => false,
            waitForMetadataUpdate: async () => false,
        });

        expect(result?.message).toBe('hello');
    });

    it('wakes on metadata update and then processes a pending item', async () => {
        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };

        const queue = new MessageQueue2<Mode>(() => 'hash');

        let pendingText: string | null = null;
        const popPendingMessage = async () => {
            if (!pendingText) return false;
            const text = pendingText;
            pendingText = null;
            queue.pushImmediate(text, mode);
            return true;
        };

        const metadataWaiters: Array<(ok: boolean) => void> = [];
        const waitForMetadataUpdate = async (abortSignal?: AbortSignal) => {
            if (abortSignal?.aborted) return false;
            return await new Promise<boolean>((resolve) => {
                const onAbort = () => resolve(false);
                abortSignal?.addEventListener('abort', onAbort, { once: true });
                metadataWaiters.push((ok) => {
                    abortSignal?.removeEventListener('abort', onAbort);
                    resolve(ok);
                });
            });
        };

        const abortController = new AbortController();
        const promise = waitForMessagesOrPending({
            messageQueue: queue,
            abortSignal: abortController.signal,
            popPendingMessage,
            waitForMetadataUpdate,
        });

        // Wait until the helper is actually listening for a metadata update.
        for (let i = 0; i < 50 && metadataWaiters.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 0));
        }
        expect(metadataWaiters.length).toBeGreaterThan(0);

        pendingText = 'from-pending';
        // Wake the waiter as if metadata changed due to a new pending enqueue.
        metadataWaiters.shift()?.(true);

        const result = await promise;
        expect(result?.message).toBe('from-pending');
    });
});
