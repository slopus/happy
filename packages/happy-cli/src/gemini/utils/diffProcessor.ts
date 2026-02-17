/**
 * Diff Processor for Gemini - Handles file edit events and tracks unified_diff changes
 *
 * This processor tracks changes from fs-edit events and tool_call results that contain
 * file modification information, converting them to GeminiDiff tool calls.
 *
 * Sends only a lightweight summary (file path + stats) instead of full diff content,
 * to avoid large payloads to the mobile app.
 *
 * Full diff content is persisted to disk via diffStore for on-demand retrieval.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { saveDiffRecords } from '@/modules/common/diffStore';

export interface DiffToolCall {
    type: 'tool-call';
    name: 'GeminiDiff';
    callId: string;
    input: {
        callId: string;
        files: string[];
        stats: { additions: number; deletions: number };
        fileStats?: Record<string, { additions: number; deletions: number }>;
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
 * Parse a unified diff string to extract file names and per-file + aggregate stats.
 */
function summarizeUnifiedDiff(unifiedDiff: string): {
    files: string[];
    stats: { additions: number; deletions: number };
    fileStats: Record<string, { additions: number; deletions: number }>;
} {
    const files: string[] = [];
    const fileStats: Record<string, { additions: number; deletions: number }> = {};
    let currentFile: string | null = null;
    let fallbackFile: string | null = null; // From "--- a/..." for deleted files
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const line of unifiedDiff.split('\n')) {
        if (line.startsWith('--- a/')) {
            fallbackFile = line.replace(/^--- a\//, '');
        } else if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            const raw = line.replace(/^\+\+\+ (b\/)?/, '');
            // For deleted files, +++ /dev/null — use fallback from --- a/...
            const fileName = (raw && raw !== '/dev/null') ? raw : fallbackFile;
            fallbackFile = null;
            if (fileName && !files.includes(fileName)) {
                files.push(fileName);
            }
            currentFile = fileName || null;
            if (currentFile && !fileStats[currentFile]) {
                fileStats[currentFile] = { additions: 0, deletions: 0 };
            }
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
            totalAdditions++;
            if (currentFile && fileStats[currentFile]) {
                fileStats[currentFile].additions++;
            }
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            totalDeletions++;
            if (currentFile && fileStats[currentFile]) {
                fileStats[currentFile].deletions++;
            }
        }
    }

    return { files, stats: { additions: totalAdditions, deletions: totalDeletions }, fileStats };
}

export class GeminiDiffProcessor {
    private previousDiffs = new Map<string, string>(); // Track diffs per file path
    private onMessage: ((message: any) => void) | null = null;
    private sessionId: string | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
    }

    /**
     * Set the session ID for persisting diffs to disk.
     */
    setSessionId(sessionId: string): void {
        this.sessionId = sessionId;
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

            const { files, stats, fileStats } = summarizeUnifiedDiff(unifiedDiff);
            // Ensure the path is included in files list
            if (!files.includes(path) && path) {
                files.unshift(path);
            }

            const callId = randomUUID();

            // Persist to disk — store per-file stats for each file
            if (this.sessionId) {
                const uniqueFiles = [...new Set(files)];
                saveDiffRecords(this.sessionId, uniqueFiles.map((fp) => ({
                    callId,
                    agent: 'gemini' as const,
                    filePath: fp,
                    diff: unifiedDiff,
                    additions: fileStats[fp]?.additions ?? 0,
                    deletions: fileStats[fp]?.deletions ?? 0,
                    timestamp: Date.now(),
                })));
            }

            const toolCall: DiffToolCall = {
                type: 'tool-call',
                name: 'GeminiDiff',
                callId: callId,
                input: { callId, files, stats, fileStats, description },
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
}
