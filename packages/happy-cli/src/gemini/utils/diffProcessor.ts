/**
 * Diff Processor for Gemini - Handles file edit events and tracks unified_diff changes
 * 
 * This processor tracks changes from fs-edit events and tool_call results that contain
 * file modification information, converting them to GeminiDiff tool calls similar to Codex.
 * 
 * Note: Gemini ACP doesn't have direct turn_diff events like Codex, so we track
 * file changes through fs-edit events and tool results that may contain diff information.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

export interface DiffToolCall {
    type: 'tool-call';
    name: 'GeminiDiff';
    callId: string;
    input: {
        unified_diff?: string;
        path?: string;
        description?: string;
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

export class GeminiDiffProcessor {
    private previousDiffs = new Map<string, string>(); // Track diffs per file path
    private onMessage: ((message: any) => void) | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
    }

    /**
     * Process an fs-edit event and check if it contains diff information
     */
    processFsEdit(path: string, description?: string, diff?: string): void {
        logger.debug(`[GeminiDiffProcessor] Processing fs-edit for path: ${path}`);
        
        // If we have a diff, process it
        if (diff) {
            this.processDiff(path, diff, description);
        } else {
            // Even without diff, we can track that a file was edited
            // Generate a simple diff representation
            const simpleDiff = `File edited: ${path}${description ? ` - ${description}` : ''}`;
            this.processDiff(path, simpleDiff, description);
        }
    }

    /**
     * Process a tool result that may contain diff information
     */
    processToolResult(toolName: string, result: any, callId: string): void {
        // Check if result contains diff information
        if (result && typeof result === 'object') {
            // Look for common diff fields
            const diff = result.diff || result.unified_diff || result.patch;
            const path = result.path || result.file;
            
            if (diff && path) {
                logger.debug(`[GeminiDiffProcessor] Found diff in tool result: ${toolName} (${callId})`);
                this.processDiff(path, diff, result.description);
            } else if (result.changes && typeof result.changes === 'object') {
                // Handle multiple file changes (like patch operations)
                for (const [filePath, change] of Object.entries(result.changes)) {
                    const changeDiff = (change as any).diff || (change as any).unified_diff || 
                                     JSON.stringify(change);
                    this.processDiff(filePath, changeDiff, (change as any).description);
                }
            }
        }
    }

    /**
     * Process a unified diff and check if it has changed from the previous value
     */
    private processDiff(path: string, unifiedDiff: string, description?: string): void {
        const previousDiff = this.previousDiffs.get(path);
        
        // Check if the diff has changed from the previous value
        if (previousDiff !== unifiedDiff) {
            logger.debug(`[GeminiDiffProcessor] Unified diff changed for ${path}, sending GeminiDiff tool call`);
            
            // Generate a unique call ID for this diff
            const callId = randomUUID();
            
            // Send tool call for the diff change
            const toolCall: DiffToolCall = {
                type: 'tool-call',
                name: 'GeminiDiff',
                callId: callId,
                input: {
                    unified_diff: unifiedDiff,
                    path: path,
                    description: description
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
        this.previousDiffs.set(path, unifiedDiff);
        logger.debug(`[GeminiDiffProcessor] Updated stored diff for ${path}`);
    }

    /**
     * Reset the processor state (called on task_complete or turn_aborted)
     */
    reset(): void {
        logger.debug('[GeminiDiffProcessor] Resetting diff state');
        this.previousDiffs.clear();
    }

    /**
     * Set the message callback for sending messages directly
     */
    setMessageCallback(callback: (message: any) => void): void {
        this.onMessage = callback;
    }

    /**
     * Get the current diff value for a specific path
     */
    getCurrentDiff(path: string): string | null {
        return this.previousDiffs.get(path) || null;
    }

    /**
     * Get all tracked diffs
     */
    getAllDiffs(): Map<string, string> {
        return new Map(this.previousDiffs);
    }
}
