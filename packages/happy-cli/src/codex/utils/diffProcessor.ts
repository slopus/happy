/**
 * Diff Processor - Handles turn_diff messages and tracks unified_diff changes
 *
 * This processor tracks changes to the unified_diff field in turn_diff messages
 * and sends CodexDiff tool calls with a lightweight summary (file names + stats)
 * instead of the full diff content, to avoid large payloads to the mobile app.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

export interface DiffToolCall {
    type: 'tool-call';
    name: 'CodexDiff';
    callId: string;
    input: {
        files: string[];
        stats: { additions: number; deletions: number };
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

/**
 * Parse a unified diff string to extract file names and line stats.
 */
function summarizeUnifiedDiff(unifiedDiff: string): { files: string[]; stats: { additions: number; deletions: number } } {
    const files: string[] = [];
    let additions = 0;
    let deletions = 0;

    for (const line of unifiedDiff.split('\n')) {
        if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            const fileName = line.replace(/^\+\+\+ (b\/)?/, '');
            if (fileName && !files.includes(fileName)) {
                files.push(fileName);
            }
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
            additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            deletions++;
        }
    }

    return { files, stats: { additions, deletions } };
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

            const { files, stats } = summarizeUnifiedDiff(unifiedDiff);

            // Generate a unique call ID for this diff
            const callId = randomUUID();

            // Send tool call with lightweight summary instead of full diff
            const toolCall: DiffToolCall = {
                type: 'tool-call',
                name: 'CodexDiff',
                callId: callId,
                input: { files, stats },
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
