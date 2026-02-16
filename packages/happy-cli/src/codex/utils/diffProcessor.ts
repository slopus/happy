/**
 * Diff Processor - Handles turn_diff messages and tracks unified_diff changes
 *
 * This processor tracks changes to the unified_diff field in turn_diff messages
 * and sends CodexDiff tool calls with a lightweight summary (file names + stats)
 * instead of the full diff content, to avoid large payloads to the mobile app.
 *
 * Full diff content is persisted to disk via diffStore for on-demand retrieval.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { saveDiffRecords, type DiffRecord } from '@/modules/common/diffStore';

export interface DiffToolCall {
    type: 'tool-call';
    name: 'CodexDiff';
    callId: string;
    input: {
        callId: string;
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

interface PerFileDiff {
    filePath: string;
    diff: string;
    additions: number;
    deletions: number;
}

/**
 * Split a cumulative unified diff into per-file chunks and compute stats for each.
 */
function splitUnifiedDiff(unifiedDiff: string): PerFileDiff[] {
    const results: PerFileDiff[] = [];
    const lines = unifiedDiff.split('\n');

    let currentFile: string | null = null;
    let fallbackFile: string | null = null; // From "--- a/..." for deleted files
    let currentLines: string[] = [];
    let additions = 0;
    let deletions = 0;

    function flush() {
        if (currentFile && currentLines.length > 0) {
            results.push({
                filePath: currentFile,
                diff: currentLines.join('\n'),
                additions,
                deletions,
            });
        }
        currentFile = null;
        fallbackFile = null;
        currentLines = [];
        additions = 0;
        deletions = 0;
    }

    for (const line of lines) {
        // New file boundary: "diff --git a/... b/..."
        if (line.startsWith('diff --git ')) {
            flush();
            currentLines.push(line);
        } else if (line.startsWith('--- a/')) {
            // Track source file name for deleted files
            fallbackFile = line.replace(/^--- a\//, '');
            currentLines.push(line);
        } else if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            const fileName = line.replace(/^\+\+\+ (b\/)?/, '');
            // Use fallback for deleted files (+++ /dev/null)
            if (fileName && fileName !== '/dev/null') {
                currentFile = fileName;
            } else if (fallbackFile) {
                currentFile = fallbackFile;
            }
            currentLines.push(line);
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
            additions++;
            currentLines.push(line);
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            deletions++;
            currentLines.push(line);
        } else {
            currentLines.push(line);
        }
    }
    flush();

    return results;
}

export class DiffProcessor {
    private previousPerFile = new Map<string, string>(); // filePath → diff content
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
     * Process a turn_diff message. The unified_diff is cumulative (entire session).
     * We split by file, compare with previous to find changed files, and persist incremental diffs.
     */
    processDiff(unifiedDiff: string): void {
        const perFile = splitUnifiedDiff(unifiedDiff);

        // Find files that changed since last turn_diff
        const changedFiles: PerFileDiff[] = [];
        for (const file of perFile) {
            const prev = this.previousPerFile.get(file.filePath);
            if (prev !== file.diff) {
                changedFiles.push(file);
            }
        }

        if (changedFiles.length === 0) {
            // Replace entire map so removed files don't linger
            this.rebuildPerFileMap(perFile);
            return;
        }

        logger.debug(`[DiffProcessor] ${changedFiles.length} file(s) changed, sending CodexDiff tool call`);

        const callId = randomUUID();

        // Compute aggregate stats from changed files only
        let totalAdditions = 0;
        let totalDeletions = 0;
        const files: string[] = [];
        for (const f of changedFiles) {
            files.push(f.filePath);
            totalAdditions += f.additions;
            totalDeletions += f.deletions;
        }

        // Persist to disk
        if (this.sessionId) {
            const records: DiffRecord[] = changedFiles.map((f) => ({
                callId,
                agent: 'codex' as const,
                filePath: f.filePath,
                diff: f.diff,
                additions: f.additions,
                deletions: f.deletions,
                timestamp: Date.now(),
            }));
            saveDiffRecords(this.sessionId, records);
        }

        // Send lightweight summary to App
        const toolCall: DiffToolCall = {
            type: 'tool-call',
            name: 'CodexDiff',
            callId,
            input: { callId, files, stats: { additions: totalAdditions, deletions: totalDeletions } },
            id: randomUUID(),
        };
        this.onMessage?.(toolCall);

        const toolResult: DiffToolResult = {
            type: 'tool-call-result',
            callId,
            output: { status: 'completed' },
            id: randomUUID(),
        };
        this.onMessage?.(toolResult);

        // Replace entire map so removed files don't linger
        this.rebuildPerFileMap(perFile);
    }

    private rebuildPerFileMap(perFile: PerFileDiff[]): void {
        this.previousPerFile.clear();
        for (const file of perFile) {
            this.previousPerFile.set(file.filePath, file.diff);
        }
    }

    /**
     * Reset the processor state (called on task_complete or turn_aborted)
     */
    reset(): void {
        logger.debug('[DiffProcessor] Resetting diff state');
        this.previousPerFile.clear();
    }

    /**
     * Set the message callback for sending messages directly
     */
    setMessageCallback(callback: (message: any) => void): void {
        this.onMessage = callback;
    }
}
