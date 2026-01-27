import { MessageQueue2 } from '@/utils/MessageQueue2';

export type MessageBatch<T> = {
    message: string;
    mode: T;
    isolate: boolean;
    hash: string;
};

export async function waitForMessagesOrPending<T>(opts: {
    messageQueue: MessageQueue2<T>;
    abortSignal: AbortSignal;
    popPendingMessage: () => Promise<boolean>;
    waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
}): Promise<MessageBatch<T> | null> {
    while (true) {
        if (opts.abortSignal.aborted) {
            return null;
        }

        // Fast path
        if (opts.messageQueue.size() > 0) {
            return await opts.messageQueue.waitForMessagesAndGetAsString(opts.abortSignal);
        }

        // Give pending queue a chance to materialize a message before we park.
        await opts.popPendingMessage();

        // If queue is still empty, wait for either:
        // - a new transcript message (via normal update delivery), OR
        // - a metadata change (e.g. a new pending enqueue)
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        opts.abortSignal.addEventListener('abort', onAbort, { once: true });
        if (opts.abortSignal.aborted) {
            controller.abort();
        }

        try {
            const winner = await Promise.race([
                opts.messageQueue
                    .waitForMessagesAndGetAsString(controller.signal)
                    .then((batch) => ({ kind: 'batch' as const, batch })),
                opts.waitForMetadataUpdate(controller.signal).then((ok) => ({ kind: 'meta' as const, ok })),
            ]);

            controller.abort('waitForMessagesOrPending');

            if (winner.kind === 'batch') {
                return winner.batch;
            }

            if (!winner.ok) {
                return null;
            }

            // Metadata updated – loop to try popPendingMessage again.
        } finally {
            opts.abortSignal.removeEventListener('abort', onAbort);
        }
    }
}
