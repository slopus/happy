import { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-code";

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

        const waiter = this.waiters.shift();
        if (waiter) {
            waiter({
                type: 'user',
                message: {
                    role: 'user',
                    content: message,
                },
                parent_tool_use_id: null,
                session_id: '',
            });
        } else {
            this.queue.push({
                type: 'user',
                message: {
                    role: 'user',
                    content: message,
                },
                parent_tool_use_id: null,
                session_id: '',
            });
        }
    }

    /**
     * Close the queue - no more messages can be pushed
     */
    close(): void {
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
        while (true) {
            const message = this.queue.shift();
            if (message !== undefined) {
                yield message;
                continue;
            }

            if (this.closed) {
                return;
            }

            // Wait for next message
            const nextMessage = await this.waitForNext();
            if (nextMessage === undefined) {
                return;
            }
            yield nextMessage;
        }
    }

    /**
     * Wait for the next message or queue closure
     */
    private waitForNext(): Promise<SDKUserMessage | undefined> {
        return new Promise((resolve) => {
            if (this.closed) {
                resolve(undefined);
                return;
            }

            const waiter = (value: SDKUserMessage) => resolve(value);
            this.waiters.push(waiter);

            // Also listen for close event
            this.closePromise?.then(() => {
                const index = this.waiters.indexOf(waiter);
                if (index !== -1) {
                    this.waiters.splice(index, 1);
                    resolve(undefined);
                }
            });
        });
    }
}