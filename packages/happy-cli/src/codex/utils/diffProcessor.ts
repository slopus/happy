/**
 * Diff Processor - Handles turn_diff messages and tracks unified_diff changes
 * 
 * This processor tracks changes to the unified_diff field in turn_diff messages
 * and sends CodexDiff tool calls when the diff changes from its previous value.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

export interface DiffToolCall {
    type: 'tool-call';
    name: 'CodexDiff';
    callId: string;
    input: {
        unified_diff: string;
    };
    id: string;
}

export interface DiffToolResult {
    type: 'tool-call-result';
    callId: string;
    output: {
        status: 'completed';
    };
    id: string;
}

export class DiffProcessor {
    private previousDiff: string | null = null;
    private onMessage: ((message: any) => void) | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
    }

    /**
     * Process a turn_diff message and check if the unified_diff has changed
     */
    processDiff(unifiedDiff: string): void {
        // Check if the diff has changed from the previous value
        if (this.previousDiff !== unifiedDiff) {
            logger.debug('[DiffProcessor] Unified diff changed, sending CodexDiff tool call');
            
            // Generate a unique call ID for this diff
            const callId = randomUUID();
            
            // Send tool call for the diff change
            const toolCall: DiffToolCall = {
                type: 'tool-call',
                name: 'CodexDiff',
                callId: callId,
                input: {
                    unified_diff: unifiedDiff
                },
                id: randomUUID()
            };
            
            this.onMessage?.(toolCall);
            
            // Immediately send the tool result to mark it as completed
            const toolResult: DiffToolResult = {
                type: 'tool-call-result',
                callId: callId,
                output: {
                    status: 'completed'
                },
                id: randomUUID()
            };
            
            this.onMessage?.(toolResult);
        }
        
        // Update the stored diff value
        this.previousDiff = unifiedDiff;
        logger.debug('[DiffProcessor] Updated stored diff');
    }

    /**
     * Reset the processor state (called on task_complete or turn_aborted)
     */
    reset(): void {
        logger.debug('[DiffProcessor] Resetting diff state');
        this.previousDiff = null;
    }

    /**
     * Set the message callback for sending messages directly
     */
    setMessageCallback(callback: (message: any) => void): void {
        this.onMessage = callback;
    }

    /**
     * Get the current diff value
     */
    getCurrentDiff(): string | null {
        return this.previousDiff;
    }
}