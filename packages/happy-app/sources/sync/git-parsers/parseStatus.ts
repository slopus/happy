/**
 * Git status parser for porcelain output
 * Based on simple-git implementation with enhancements for the Happy codebase
 */

import { LineParser } from './LineParser';

export interface GitFileEntry {
    path: string;
    index: string;  // Staged status character
    working_dir: string;  // Working directory status character
    from?: string;  // Original path for renamed files
}

export interface GitStatusSummary {
    files: GitFileEntry[];
    staged: string[];
    modified: string[];
    created: string[];
    deleted: string[];
    renamed: string[];
    conflicted: string[];
    not_added: string[];  // Untracked files
}

const STATUS_REGEX = /^(.)(.) (.*)$/;
const RENAME_REGEX = /^(.)(.) (.*) -> (.*)$/;

/**
 * Parse git status --porcelain output into structured data
 */
export function parseStatusSummary(statusOutput: string): GitStatusSummary {
    const lines = statusOutput.trim().split('\n').filter(line => line.length > 0);
    
    const result: GitStatusSummary = {
        files: [],
        staged: [],
        modified: [],
        created: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: []
    };

    const parser = new LineParser(
        [STATUS_REGEX, RENAME_REGEX],
        (target: GitStatusSummary, matches: (string | undefined)[]) => {
            if (!matches[1] || !matches[2] || !matches[3]) return;

            const index = matches[1];
            const working_dir = matches[2];
            let path = matches[3];
            let from: string | undefined;

            // Handle renamed files
            if (matches[4]) {
                from = matches[3];
                path = matches[4];
            }

            const entry: GitFileEntry = {
                path,
                index,
                working_dir,
                from
            };

            target.files.push(entry);

            // Categorize files based on status
            categorizeFile(target, entry);
        }
    );

    return parser.parse(result, lines);
}

function categorizeFile(summary: GitStatusSummary, entry: GitFileEntry): void {
    const { index, working_dir, path } = entry;

    // Handle staged changes (index column)
    if (index !== ' ' && index !== '?') {
        summary.staged.push(path);
        
        switch (index) {
            case 'A':
                summary.created.push(path);
                break;
            case 'D':
                summary.deleted.push(path);
                break;
            case 'R':
                summary.renamed.push(path);
                break;
            case 'M':
                // Don't add to modified if it's also in created (new file that was modified)
                if (!summary.created.includes(path)) {
                    summary.modified.push(path);
                }
                break;
            case 'U':
                summary.conflicted.push(path);
                break;
        }
    }

    // Handle working directory changes
    if (working_dir !== ' ') {
        switch (working_dir) {
            case 'M':
                if (!summary.modified.includes(path)) {
                    summary.modified.push(path);
                }
                break;
            case 'D':
                if (!summary.deleted.includes(path)) {
                    summary.deleted.push(path);
                }
                break;
            case 'R':
                if (!summary.renamed.includes(path)) {
                    summary.renamed.push(path);
                }
                break;
            case '?':
                summary.not_added.push(path);
                break;
            case 'U':
                if (!summary.conflicted.includes(path)) {
                    summary.conflicted.push(path);
                }
                break;
        }
    }
}

/**
 * Count files by their status
 */
export function getStatusCounts(summary: GitStatusSummary): {
    staged: number;
    modified: number;
    untracked: number;
    conflicted: number;
    total: number;
} {
    return {
        staged: summary.staged.length,
        modified: summary.modified.length,
        untracked: summary.not_added.length,
        conflicted: summary.conflicted.length,
        total: summary.files.length
    };
}

/**
 * Check if repository has any changes
 */
export function isDirty(summary: GitStatusSummary): boolean {
    return summary.files.length > 0;
}