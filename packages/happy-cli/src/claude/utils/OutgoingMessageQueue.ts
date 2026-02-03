/**
 * Outgoing Message Queue with strict ordering using incremental IDs
 * 
 * Ensures messages are always sent in the order they were received,
 * while allowing delayed messages to be released early when needed.
 */

import { AsyncLock } from '@/utils/lock';

interface QueueItem {
    id: number;                    // Incremental ID for ordering
    logMessage: any;               
    delayed: boolean;              // Whether this message should be delayed
    delayMs: number;               // Delay duration (e.g., 250ms)
    toolCallIds?: string[];        // Tool calls to track for early release
    released: boolean;             // Whether delay has been released
    sent: boolean;                 // Whether message has been sent
}

export class OutgoingMessageQueue {
    private queue: QueueItem[] = [];
    private nextId = 1;
    private lock = new AsyncLock();
    private processTimer?: NodeJS.Timeout;
    private delayTimers = new Map<number, NodeJS.Timeout>();
    
    constructor(private sendFunction: (message: any) => void) {}
    
    /**
     * Add message to queue
     */
    enqueue(logMessage: any, options?: {
        delay?: number,
        toolCallIds?: string[]
    }) {
        this.lock.inLock(async () => {
            const item: QueueItem = {
                id: this.nextId++,
                logMessage,
                delayed: !!options?.delay,
                delayMs: options?.delay || 0,
                toolCallIds: options?.toolCallIds,
                released: !options?.delay,  // Not delayed = already released
                sent: false
            };
            
            this.queue.push(item);
            
            // If delayed, set timer to release it
            if (item.delayed) {
                const timer = setTimeout(() => {
                    this.releaseItem(item.id);
                }, item.delayMs);
                this.delayTimers.set(item.id, timer);
            }
        });
        
        // Try to process queue
        this.scheduleProcessing();
    }
    
    /**
     * Release specific item by ID
     */
    private async releaseItem(itemId: number): Promise<void> {
        await this.lock.inLock(async () => {
            const item = this.queue.find(i => i.id === itemId);
            if (item && !item.released) {
                item.released = true;
                
                // Clear timer if exists
                const timer = this.delayTimers.get(itemId);
                if (timer) {
                    clearTimeout(timer);
                    this.delayTimers.delete(itemId);
                }
            }
        });
        
        this.scheduleProcessing();
    }
    
    /**
     * Release all messages with specific tool call ID
     */
    async releaseToolCall(toolCallId: string): Promise<void> {
        await this.lock.inLock(async () => {
            for (const item of this.queue) {
                if (item.toolCallIds?.includes(toolCallId) && !item.released) {
                    item.released = true;
                    
                    // Clear timer if exists
                    const timer = this.delayTimers.get(item.id);
                    if (timer) {
                        clearTimeout(timer);
                        this.delayTimers.delete(item.id);
                    }
                }
            }
        });
        
        this.scheduleProcessing();
    }
    
    /**
     * Process queue - send messages in ID order that are released
     * (Internal implementation without lock)
     */
    private processQueueInternal(): void {
        // Sort by ID to ensure order
        this.queue.sort((a, b) => a.id - b.id);
        
        // Process from front of queue
        while (this.queue.length > 0) {
            const item = this.queue[0];
            
            // If not released yet, stop processing (maintain order)
            if (!item.released) {
                break;
            }
            
            // Send if not already sent
            if (!item.sent) {
                if (item.logMessage.type !== 'system') {
                    this.sendFunction(item.logMessage);
                }
                item.sent = true;
            }
            
            // Remove from queue
            this.queue.shift();
        }
    }
    
    /**
     * Process queue - send messages in ID order that are released
     */
    private async processQueue(): Promise<void> {
        await this.lock.inLock(async () => {
            this.processQueueInternal();
        });
    }
    
    /**
     * Flush all messages immediately (for cleanup)
     */
    async flush(): Promise<void> {
        await this.lock.inLock(async () => {
            // Clear all delay timers
            for (const timer of this.delayTimers.values()) {
                clearTimeout(timer);
            }
            this.delayTimers.clear();
            
            // Mark all as released
            for (const item of this.queue) {
                item.released = true;
            }
            
            // Process everything - use internal method since we already have the lock
            this.processQueueInternal();
        });
    }
    
    /**
     * Schedule processing on next tick
     */
    private scheduleProcessing(): void {
        if (this.processTimer) {
            clearTimeout(this.processTimer);
        }
        
        this.processTimer = setTimeout(() => {
            this.processQueue();
        }, 0);
    }
    
    /**
     * Cleanup timers and resources
     */
    destroy(): void {
        if (this.processTimer) {
            clearTimeout(this.processTimer);
        }
        
        for (const timer of this.delayTimers.values()) {
            clearTimeout(timer);
        }
        this.delayTimers.clear();
    }
}