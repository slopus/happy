/**
 * Diff Processor for Gemini - Handles file edit events and tracks unified_diff changes
 *
 * This processor tracks changes from fs-edit events and tool_call results that contain
 * file modification information, converting them to GeminiDiff tool calls.
 *
 * Sends only a lightweight summary (file path + stats) instead of full diff content,
 * to avoid large payloads to the mobile app.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

export interface DiffToolCall {
    type: 'tool-call';
    name: 'GeminiDiff';
    callId: string;
    input: {
        files: string[];
        stats: { additions: number; deletions: number };
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

        if (diff) {
            this.processDiff(path, diff, description);
        } else {
            this.processDiff(path, `File edited: ${path}`, description);
        }
    }

    /**
     * Process a tool result that may contain diff information
     */
    processToolResult(toolName: string, result: any, callId: string): void {
        if (result && typeof result === 'object') {
            const diff = result.diff || result.unified_diff || result.patch;
            const path = result.path || result.file;

            if (diff && path) {
                logger.debug(`[GeminiDiffProcessor] Found diff in tool result: ${toolName} (${callId})`);
                this.processDiff(path, diff, result.description);
            } else if (result.changes && typeof result.changes === 'object') {
                for (const [filePath, change] of Object.entries(result.changes)) {
                    const changeDiff = (change as any).diff || (change as any).unified_diff ||
                                     JSON.stringify(change);
                    this.processDiff(filePath, changeDiff, (change as any).description);
                }
            }
        }
    }

    /**
     * Process a unified diff and send lightweight summary if changed
     */
    private processDiff(path: string, unifiedDiff: string, description?: string): void {
        const previousDiff = this.previousDiffs.get(path);

        if (previousDiff !== unifiedDiff) {
            logger.debug(`[GeminiDiffProcessor] Unified diff changed for ${path}, sending GeminiDiff tool call`);

            const { files, stats } = summarizeUnifiedDiff(unifiedDiff);
            // Ensure the path is included in files list
            if (!files.includes(path) && path) {
                files.unshift(path);
            }

            const callId = randomUUID();

            const toolCall: DiffToolCall = {
                type: 'tool-call',
                name: 'GeminiDiff',
                callId: callId,
                input: { files, stats, description },
                id: randomUUID()
            };

            this.onMessage?.(toolCall);

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
