import type { ApiEphemeralActivityUpdate } from '../apiTypes';

export class ActivityUpdateAccumulator {
    private pendingUpdates = new Map<string, ApiEphemeralActivityUpdate>();
    private lastEmittedStates = new Map<string, { active: boolean; thinking: boolean }>();
    private timeoutId: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private flushHandler: (updates: Map<string, ApiEphemeralActivityUpdate>) => void,
        private debounceDelay: number = 500
    ) {}

    addUpdate(update: ApiEphemeralActivityUpdate): void {
        const sessionId = update.id;
        const lastState = this.lastEmittedStates.get(sessionId);

        // Check if this is a significant state change that needs immediate emission
        const isSignificantChange = !lastState || 
            lastState.active !== update.active || 
            lastState.thinking !== update.thinking;

        if (isSignificantChange) {
            // Cancel any pending timeout
            if (this.timeoutId) {
                clearTimeout(this.timeoutId);
                this.timeoutId = null;
            }

            // Add the immediate update to pending updates
            this.pendingUpdates.set(sessionId, update);

            // Flush all pending updates together (batched)
            this.flushPendingUpdates();
        } else {
            // Accumulate for debounced emission (only timestamp updates)
            this.pendingUpdates.set(sessionId, update);

            // Only start a new timer if one isn't already running
            if (!this.timeoutId) {
                this.timeoutId = setTimeout(() => {
                    this.flushPendingUpdates();
                    this.timeoutId = null;
                }, this.debounceDelay);
            }
            // Don't reset the timer for subsequent updates - let it fire!
        }
    }

    private flushPendingUpdates(): void {
        if (this.pendingUpdates.size > 0) {
            // Create a copy of the pending updates
            const updatesToFlush = new Map(this.pendingUpdates);
            
            // Emit all updates in a single batch
            this.flushHandler(updatesToFlush);
            
            // Update last emitted states for all flushed updates
            for (const [sessionId, update] of updatesToFlush) {
                this.lastEmittedStates.set(sessionId, {
                    active: update.active,
                    thinking: update.thinking
                });
            }
            
            // Clear pending updates
            this.pendingUpdates.clear();
        }
    }

    cancel(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.pendingUpdates.clear();
    }

    reset(): void {
        this.cancel();
        this.lastEmittedStates.clear();
    }

    flush(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.flushPendingUpdates();
    }
}