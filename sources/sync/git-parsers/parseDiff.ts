/**
 * Git diff parser for numstat and diff summary output
 * Based on simple-git implementation with enhancements
 */

import { LineParser } from './LineParser';

export interface DiffFileStat {
    file: string;
    changes: number;
    insertions: number;
    deletions: number;
    binary: boolean;
}

export interface DiffSummary {
    files: DiffFileStat[];
    insertions: number;
    deletions: number;
    changes: number;
    changed: number;  // Number of files changed
}

// Regex for git diff --numstat output: "insertions\tdeletions\tfilename"
const NUMSTAT_REGEX = /^(\d+|-)\t(\d+|-)\t(.*)$/;

// Regex for git diff --stat output summary line: " X files changed, Y insertions(+), Z deletions(-)"
const STAT_SUMMARY_REGEX = /^\s*(\d+)\s+files? changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/;

/**
 * Parse git diff --numstat output
 */
export function parseNumStat(numStatOutput: string): DiffSummary {
    const lines = numStatOutput.trim().split('\n').filter(line => line.length > 0);
    
    const result: DiffSummary = {
        files: [],
        insertions: 0,
        deletions: 0,
        changes: 0,
        changed: 0
    };

    const parser = new LineParser(
        NUMSTAT_REGEX,
        (target: DiffSummary, matches: (string | undefined)[]) => {
            const insertionsStr = matches[1];
            const deletionsStr = matches[2];
            const file = matches[3];

            if (!file || !insertionsStr || !deletionsStr) return;

            // Handle binary files (git shows '-' for binary files)
            const isBinary = insertionsStr === '-' || deletionsStr === '-';
            const insertions = isBinary ? 0 : parseInt(insertionsStr, 10);
            const deletions = isBinary ? 0 : parseInt(deletionsStr, 10);
            const changes = insertions + deletions;

            const fileStat: DiffFileStat = {
                file,
                changes,
                insertions,
                deletions,
                binary: isBinary
            };

            target.files.push(fileStat);
            target.insertions += insertions;
            target.deletions += deletions;
            target.changes += changes;
            target.changed++;
        }
    );

    return parser.parse(result, lines);
}

/**
 * Parse git diff --stat output summary
 */
export function parseDiffStat(diffStatOutput: string): DiffSummary {
    const lines = diffStatOutput.trim().split('\n');
    const summaryLine = lines[lines.length - 1];
    
    const result: DiffSummary = {
        files: [],
        insertions: 0,
        deletions: 0,
        changes: 0,
        changed: 0
    };

    // Parse the summary line
    const match = STAT_SUMMARY_REGEX.exec(summaryLine);
    if (match) {
        result.changed = parseInt(match[1], 10) || 0;
        result.insertions = parseInt(match[2], 10) || 0;
        result.deletions = parseInt(match[3], 10) || 0;
        result.changes = result.insertions + result.deletions;
    }

    // Parse individual file stats from the other lines
    const fileLines = lines.slice(0, -1).filter(line => line.trim().length > 0);
    for (const line of fileLines) {
        const fileStat = parseFileStatLine(line);
        if (fileStat) {
            result.files.push(fileStat);
        }
    }

    return result;
}

/**
 * Parse a single file stat line from git diff --stat
 * Example: " src/file.ts | 10 +++++-----"
 */
function parseFileStatLine(line: string): DiffFileStat | null {
    const parts = line.split('|');
    if (parts.length !== 2) return null;

    const file = parts[0].trim();
    const statsPart = parts[1].trim();
    
    // Extract numbers and +/- indicators
    const match = /(\d+)\s*(.*)/. exec(statsPart);
    if (!match) return null;

    const changes = parseInt(match[1], 10);
    const indicators = match[2];
    
    // Count + and - characters
    const insertions = (indicators.match(/\+/g) || []).length;
    const deletions = (indicators.match(/-/g) || []).length;
    
    // Check if it's a binary file
    const binary = indicators.includes('Bin');

    return {
        file,
        changes,
        insertions,
        deletions,
        binary
    };
}

/**
 * Create a map of file paths to their diff statistics
 */
export function createDiffStatsMap(summary: DiffSummary): Record<string, { added: number; removed: number; binary: boolean }> {
    const stats: Record<string, { added: number; removed: number; binary: boolean }> = {};
    
    for (const file of summary.files) {
        stats[file.file] = {
            added: file.insertions,
            removed: file.deletions,
            binary: file.binary
        };
    }
    
    return stats;
}

/**
 * Merge two diff summaries (useful for combining staged and unstaged changes)
 */
export function mergeDiffSummaries(staged: DiffSummary, unstaged: DiffSummary): {
    stagedAdded: number;
    stagedRemoved: number;
    unstagedAdded: number;
    unstagedRemoved: number;
} {
    return {
        stagedAdded: staged.insertions,
        stagedRemoved: staged.deletions,
        unstagedAdded: unstaged.insertions,
        unstagedRemoved: unstaged.deletions
    };
}