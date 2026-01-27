import { SDKMessage, SDKUserMessage } from "@/backends/claude/sdk";
import { logger } from "@/ui/logger";

/**
 * An async iterable message queue that allows pushing messages and consuming them asynchronously
 */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
    private queue: SDKUserMessage[] = [];
    private waiters: Array<(value: SDKUserMessage) => void> = [];
    private closed = false;
    private closePromise?: Promise<void>;
    private closeResolve?: () => void;

    constructor() {
        this.closePromise = new Promise((resolve) => {
            this.closeResolve = resolve;
        });
    }

    /**
     * Push a message to the queue
     */
    push(message: string): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        logger.debug(`[MessageQueue] push() called. Waiters: ${this.waiters.length}, Queue size before: ${this.queue.length}`);
        
        const waiter = this.waiters.shift();
        if (waiter) {
            logger.debug(`[MessageQueue] Found waiter! Delivering message directly: "${message}"`);
            waiter({
                type: 'user',
                message: {
                    role: 'user',
                    content: message,
                },
            });
        } else {
            logger.debug(`[MessageQueue] No waiter found. Adding to queue: "${message}"`);
            this.queue.push({
                type: 'user',
                message: {
                    role: 'user',
                    content: message,
                },
            });
        }
        
        logger.debug(`[MessageQueue] push() completed. Waiters: ${this.waiters.length}, Queue size after: ${this.queue.length}`);
    }

    /**
     * Close the queue - no more messages can be pushed
     */
    close(): void {
        logger.debug(`[MessageQueue] close() called. Waiters: ${this.waiters.length}`);
        this.closed = true;
        this.closeResolve?.();
    }

    /**
     * Check if the queue is closed
     */
    isClosed(): boolean {
        return this.closed;
    }

    /**
     * Get the current queue size
     */
    size(): number {
        return this.queue.length;
    }

    /**
     * Async iterator implementation
     */
    async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        logger.debug(`[MessageQueue] Iterator started`);
        while (true) {
            const message = this.queue.shift();
            if (message !== undefined) {
                logger.debug(`[MessageQueue] Iterator yielding queued message`);
                yield message;
                continue;
            }

            if (this.closed) {
                logger.debug(`[MessageQueue] Iterator ending - queue closed`);
                return;
            }

            // Wait for next message
            logger.debug(`[MessageQueue] Iterator waiting for next message...`);
            const nextMessage = await this.waitForNext();
            if (nextMessage === undefined) {
                logger.debug(`[MessageQueue] Iterator ending - no more messages`);
                return;
            }
            logger.debug(`[MessageQueue] Iterator yielding waited message`);
            yield nextMessage;
        }
    }

    /**
     * Wait for the next message or queue closure
     */
    private waitForNext(): Promise<SDKUserMessage | undefined> {
        return new Promise((resolve) => {
            if (this.closed) {
                logger.debug(`[MessageQueue] waitForNext() called but queue is closed`);
                resolve(undefined);
                return;
            }

            const waiter = (value: SDKUserMessage) => resolve(value);
            this.waiters.push(waiter);
            logger.debug(`[MessageQueue] waitForNext() adding waiter. Total waiters: ${this.waiters.length}`);

            // Also listen for close event
            this.closePromise?.then(() => {
                const index = this.waiters.indexOf(waiter);
                if (index !== -1) {
                    this.waiters.splice(index, 1);
                    logger.debug(`[MessageQueue] waitForNext() waiter removed due to close. Remaining waiters: ${this.waiters.length}`);
                    resolve(undefined);
                }
            });
        });
    }
}