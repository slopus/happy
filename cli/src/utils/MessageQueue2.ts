import { logger } from "@/ui/logger";

interface QueueItem<T> {
    message: string;
    mode: T;
    modeHash: string;
}

/**
 * A mode-aware message queue that stores messages with their modes.
 * Returns consistent batches of messages with the same mode.
 */
export class MessageQueue2<T> {
    private queue: QueueItem<T>[] = [];
    private waiter: ((hasMessages: boolean) => void) | null = null;
    private closed = false;

    constructor(
        private modeHasher: (mode: T) => string
    ) {
        logger.debug(`[MessageQueue2] Initialized`);
    }

    /**
     * Push a message to the queue with a mode.
     */
    push(message: string, mode: T): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] push() called with mode hash: ${modeHash}`);

        this.queue.push({
            message,
            mode,
            modeHash
        });

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }
        
        logger.debug(`[MessageQueue2] push() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message to the beginning of the queue with a mode.
     */
    unshift(message: string, mode: T): void {
        if (this.closed) {
            throw new Error('Cannot unshift to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] unshift() called with mode hash: ${modeHash}`);

        this.queue.unshift({
            message,
            mode,
            modeHash
        });

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }
        
        logger.debug(`[MessageQueue2] unshift() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Close the queue - no more messages can be pushed
     */
    close(): void {
        logger.debug(`[MessageQueue2] close() called`);
        this.closed = true;
        
        // Notify any waiting caller
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(false);
        }
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
     * Wait for messages and return all messages with the same mode as a single string
     * Returns { message: string, mode: T } or null if aborted/closed
     */
    async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<{ message: string, mode: T } | null> {
        // If we have messages, return them immediately
        if (this.queue.length > 0) {
            return this.collectBatch();
        }
        
        // If closed or already aborted, return null
        if (this.closed || abortSignal?.aborted) {
            return null;
        }
        
        // Wait for messages to arrive
        const hasMessages = await this.waitForMessages(abortSignal);
        
        if (!hasMessages) {
            return null;
        }
        
        return this.collectBatch();
    }

    /**
     * Collect a batch of messages with the same mode
     */
    private collectBatch(): { message: string, mode: T } | null {
        if (this.queue.length === 0) {
            return null;
        }

        const firstItem = this.queue[0];
        const sameModeMessages: string[] = [];
        let mode = firstItem.mode;
        const targetModeHash = firstItem.modeHash;

        // Collect all messages with the same mode
        while (this.queue.length > 0 && this.queue[0].modeHash === targetModeHash) {
            const item = this.queue.shift()!;
            sameModeMessages.push(item.message);
        }

        // Join all messages with newlines
        const combinedMessage = sameModeMessages.join('\n');
        
        logger.debug(`[MessageQueue2] Collected batch of ${sameModeMessages.length} messages with mode hash: ${targetModeHash}`);
        
        return {
            message: combinedMessage,
            mode
        };
    }

    /**
     * Wait for messages to arrive
     */
    private waitForMessages(abortSignal?: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            let abortHandler: (() => void) | null = null;
            
            // Set up abort handler
            if (abortSignal) {
                abortHandler = () => {
                    logger.debug('[MessageQueue2] Wait aborted');
                    // Clear waiter if it's still set
                    if (this.waiter === waiterFunc) {
                        this.waiter = null;
                    }
                    resolve(false);
                };
                abortSignal.addEventListener('abort', abortHandler);
            }
            
            const waiterFunc = (hasMessages: boolean) => {
                // Clean up abort handler
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(hasMessages);
            };
            
            // Check again in case messages arrived or queue closed while setting up
            if (this.queue.length > 0) {
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(true);
                return;
            }
            
            if (this.closed || abortSignal?.aborted) {
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(false);
                return;
            }
            
            // Set the waiter
            this.waiter = waiterFunc;
            logger.debug('[MessageQueue2] Waiting for messages...');
        });
    }
}