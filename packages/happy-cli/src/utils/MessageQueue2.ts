import { logger } from "@/ui/logger";

export type PendingAttachment = { data: Uint8Array; mimeType: string; name: string };

/** An opt-in, daemon-local marker for one browser chat input. It never holds text or a session id. */
export type QueueLatencyTrace = { id: string; receivedAt: number };

interface QueueItem<T> {
    message: string;
    mode: T;
    modeHash: string;
    isolate?: boolean; // If true, this message must be processed alone
    /** Decoded image attachments owned by *this* message (per-message ownership). */
    attachments?: PendingAttachment[];
    latencyTrace?: QueueLatencyTrace;
    /**
     * Identifiers for whatever produced this message (auto-routing client request
     * ids today). They ride *beside* the mode rather than inside it: the mode is
     * hashed to decide batching, so putting per-message ids there would give every
     * message a unique hash and destroy the batching itself.
     */
    requestIds?: string[];
    /**
     * Core-minted handle for a turn that answers an external messenger request
     * (Saycode specs/desktop-messenger-channels). Kept apart from `requestIds`: those are
     * auto-routing ids that ordinary Desktop input carries too, and anything that reads "has an
     * id" as "came from a channel" would then put every routed Desktop message behind channel
     * execution approval and switch off its slash commands.
     */
    channelRequestId?: string;
}

export type CollectedBatch<T> = {
    message: string;
    mode: T;
    hash: string;
    isolate: boolean;
    attachments?: PendingAttachment[];
    /**
     * Every merged message's request ids, in batch order. A consumer that commits
     * per-execution state needs all of them: attributing a merged batch to its
     * first input alone loses the rest.
     */
    requestIds?: string[];
    inputCount: number;
    latencyTraces: QueueLatencyTrace[];
    /**
     * The channel request this batch answers. Channel turns are always pushed isolated, so a
     * batch carries at most one — and a batch with one carries nothing else.
     */
    channelRequestId?: string;
}

/**
 * A mode-aware message queue that stores messages with their modes.
 * Returns consistent batches of messages with the same mode.
 */
export class MessageQueue2<T> {
    public queue: QueueItem<T>[] = []; // Made public for testing
    private waiter: ((hasMessages: boolean) => void) | null = null;
    private closed = false;
    private onMessageHandler: ((message: string, mode: T) => void) | null = null;
    modeHasher: (mode: T) => string;

    constructor(
        modeHasher: (mode: T) => string,
        onMessageHandler: ((message: string, mode: T) => void) | null = null
    ) {
        this.modeHasher = modeHasher;
        this.onMessageHandler = onMessageHandler;
        logger.debug(`[MessageQueue2] Initialized`);
    }

    /**
     * Set a handler that will be called when a message arrives
     */
    setOnMessage(handler: ((message: string, mode: T) => void) | null): void {
        this.onMessageHandler = handler;
    }

    /** Remove only a tagged channel request; ordinary Desktop input is never selected. */
    removeByRequestId(requestId: string): number {
        const before = this.queue.length;
        this.queue = this.queue.filter(item => item.channelRequestId !== requestId);
        return before - this.queue.length;
    }

    /**
     * Push a message to the queue with a mode and an optional list of
     * attachments that travel with this message.
     */
    push(message: string, mode: T, attachments?: PendingAttachment[], requestIds?: string[], latencyTrace?: QueueLatencyTrace): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] push() called with mode hash: ${modeHash}`);

        this.queue.push({
            message,
            mode,
            modeHash,
            isolate: false,
            attachments,
            requestIds,
            latencyTrace,
        });

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

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
     * Push a message immediately without batching delay.
     * Does not clear the queue or enforce isolation.
     */
    pushImmediate(message: string, mode: T, latencyTrace?: QueueLatencyTrace): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushImmediate() called with mode hash: ${modeHash}`);

        this.queue.push({
            message,
            mode,
            modeHash,
            isolate: false,
            latencyTrace,
        });

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for immediate message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushImmediate() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message that must be processed in complete isolation.
     * Clears any pending messages and ensures this message is never batched with others.
     * Used for special commands that require dedicated processing.
     */
    /**
     * Returns the request ids of the messages this call discarded. They were
     * accepted but will never execute, so a consumer holding per-request state
     * needs to know they are dead — otherwise their decisions sit in the state
     * forever, indistinguishable from work still in flight.
     */
    pushIsolateAndClear(message: string, mode: T, attachments?: PendingAttachment[], latencyTrace?: QueueLatencyTrace): string[] {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushIsolateAndClear() called with mode hash: ${modeHash} - clearing ${this.queue.length} pending messages`);

        // Clear any pending messages to ensure this message is processed in complete isolation
        const discarded = this.queue.flatMap((item) => item.requestIds ?? []);
        this.queue = [];

        this.queue.push({
            message,
            mode,
            modeHash,
            isolate: true,
            attachments,
            latencyTrace,
        });

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for isolated message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushIsolateAndClear() completed. Queue size: ${this.queue.length}`);
        return discarded;
    }

    /**
     * Push a message that must be processed alone without discarding
     * already-queued user prompts.
     */
    pushIsolated(
        message: string,
        mode: T,
        attachments?: PendingAttachment[],
        requestIds?: string[],
        channelRequestId?: string,
        latencyTrace?: QueueLatencyTrace,
    ): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushIsolated() called with mode hash: ${modeHash}`);

        this.queue.push({
            message,
            mode,
            modeHash,
            isolate: true,
            attachments,
            requestIds,
            latencyTrace,
            channelRequestId,
        });

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for isolated message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushIsolated() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Put a message at the front without allowing it to batch with messages
     * that were already queued. Used for an automation turn that wakes an
     * existing session while preserving subsequent user input.
     */
    unshiftIsolated(message: string, mode: T, latencyTrace?: QueueLatencyTrace): void {
        if (this.closed) {
            throw new Error('Cannot unshift to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        this.queue.unshift({ message, mode, modeHash, isolate: true, latencyTrace });
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }
    }

    /**
     * Push a message to the beginning of the queue with a mode.
     */
    unshift(message: string, mode: T, latencyTrace?: QueueLatencyTrace): void {
        if (this.closed) {
            throw new Error('Cannot unshift to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] unshift() called with mode hash: ${modeHash}`);

        this.queue.unshift({
            message,
            mode,
            modeHash,
            isolate: false,
            latencyTrace,
        });

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

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
     * Reset the queue - clears all messages and resets to empty state
     */
    reset(): void {
        logger.debug(`[MessageQueue2] reset() called. Clearing ${this.queue.length} messages`);
        this.queue = [];
        this.closed = false;

        // Clear waiter without calling it since we're not closing
        this.waiter = null;
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
    async waitForMessagesAndGetAsString(abortSignal?: AbortSignal, claim?: () => boolean): Promise<CollectedBatch<T> | null> {
        // If we have messages, return them immediately
        if (this.queue.length > 0) {
            return this.collectBatch(claim);
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

        return this.collectBatch(claim);
    }

    /**
     * Collect a batch of messages with the same mode, respecting isolation requirements
     */
    private collectBatch(claim?: () => boolean): CollectedBatch<T> | null {
        if (this.queue.length === 0) {
            return null;
        }

        // Claim ownership before dequeue and before the async caller can yield. Refusal preserves the batch.
        if (claim && !claim()) return null;
        const firstItem = this.queue[0];
        const sameModeMessages: string[] = [];
        const collectedAttachments: PendingAttachment[] = [];
        const collectedRequestIds: string[] = [];
        const latencyTraces: QueueLatencyTrace[] = [];
        let channelRequestId: string | undefined;
        let mode = firstItem.mode;
        let isolate = firstItem.isolate ?? false;
        const targetModeHash = firstItem.modeHash;

        // If the first message requires isolation, only process it alone
        if (firstItem.isolate) {
            const item = this.queue.shift()!;
            sameModeMessages.push(item.message);
            if (item.attachments) collectedAttachments.push(...item.attachments);
            if (item.requestIds) collectedRequestIds.push(...item.requestIds);
            if (item.latencyTrace) latencyTraces.push(item.latencyTrace);
            channelRequestId = item.channelRequestId;
            logger.debug(`[MessageQueue2] Collected isolated message with mode hash: ${targetModeHash}`);
        } else {
            // Collect all messages with the same mode until we hit an isolated message
            while (this.queue.length > 0 &&
                this.queue[0].modeHash === targetModeHash &&
                !this.queue[0].isolate) {
                const item = this.queue.shift()!;
                sameModeMessages.push(item.message);
                if (item.attachments) collectedAttachments.push(...item.attachments);
                if (item.requestIds) collectedRequestIds.push(...item.requestIds);
                if (item.latencyTrace) latencyTraces.push(item.latencyTrace);
            }
            logger.debug(`[MessageQueue2] Collected batch of ${sameModeMessages.length} messages with mode hash: ${targetModeHash}`);
        }

        // Join all messages with newlines
        const combinedMessage = sameModeMessages.join('\n');

        return {
            message: combinedMessage,
            mode,
            hash: targetModeHash,
            isolate,
            inputCount: sameModeMessages.length,
            latencyTraces,
            attachments: collectedAttachments.length > 0 ? collectedAttachments : undefined,
            requestIds: collectedRequestIds.length > 0 ? collectedRequestIds : undefined,
            ...(channelRequestId !== undefined ? { channelRequestId } : {}),
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
