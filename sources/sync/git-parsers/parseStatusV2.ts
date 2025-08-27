/**
 * Git status parser for porcelain v2 output
 * Supports all v2 line types including branch headers, renames, conflicts, and untracked files
 */

import { LineParser } from './LineParser';

export interface GitFileEntryV2 {
    path: string;
    index: string;  // Staged status character
    working_dir: string;  // Working directory status character
    from?: string;  // Original path for renamed files
    submoduleState?: string; // 4-character submodule state
    modeHead?: string; // Octal file mode in HEAD
    modeIndex?: string; // Octal file mode in index
    modeWorktree?: string; // Octal file mode in worktree
    hashHead?: string; // Object name in HEAD
    hashIndex?: string; // Object name in index
    renameScore?: number; // Rename/copy similarity percentage
}

export interface GitBranchInfo {
    oid?: string; // Current commit or "(initial)"
    head?: string; // Current branch or "(detached)"
    upstream?: string; // Upstream branch name
    ahead?: number; // Commits ahead of upstream
    behind?: number; // Commits behind upstream
}

export interface GitStatusSummaryV2 {
    files: GitFileEntryV2[];
    staged: string[];
    modified: string[];
    created: string[];
    deleted: string[];
    renamed: string[];
    conflicted: string[];
    not_added: string[];  // Untracked files
    ignored: string[];  // Ignored files
    branch: GitBranchInfo;
    stashCount?: number; // Number of stash entries
}

// Regular expressions for different line types in porcelain v2
const BRANCH_OID_REGEX = /^# branch\.oid (.+)$/;
const BRANCH_HEAD_REGEX = /^# branch\.head (.+)$/;
const BRANCH_UPSTREAM_REGEX = /^# branch\.upstream (.+)$/;
const BRANCH_AB_REGEX = /^# branch\.ab \+(\d+) -(\d+)$/;
const STASH_REGEX = /^# stash (\d+)$/;

// File entry regexes  
const ORDINARY_CHANGE_REGEX = /^1 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.+)$/;
const RENAME_COPY_REGEX = /^2 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC])(\d{1,3}) (.+)\t(.+)$/;
const UNMERGED_REGEX = /^u (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$/;
const UNTRACKED_REGEX = /^\? (.+)$/;
const IGNORED_REGEX = /^! (.+)$/;

/**
 * Parse git status --porcelain=v2 --branch output into structured data
 */
export function parseStatusSummaryV2(statusOutput: string): GitStatusSummaryV2 {
    const lines = statusOutput.trim().split('\n').filter(line => line.length > 0);
    
    const result: GitStatusSummaryV2 = {
        files: [],
        staged: [],
        modified: [],
        created: [],
        deleted: [],
        renamed: [],
        conflicted: [],
        not_added: [],
        ignored: [],
        branch: {}
    };

    for (const line of lines) {
        // Branch information headers
        if (line.startsWith('# branch.oid ')) {
            const match = BRANCH_OID_REGEX.exec(line);
            if (match) result.branch.oid = match[1];
        } else if (line.startsWith('# branch.head ')) {
            const match = BRANCH_HEAD_REGEX.exec(line);
            if (match) result.branch.head = match[1];
        } else if (line.startsWith('# branch.upstream ')) {
            const match = BRANCH_UPSTREAM_REGEX.exec(line);
            if (match) result.branch.upstream = match[1];
        } else if (line.startsWith('# branch.ab ')) {
            const match = BRANCH_AB_REGEX.exec(line);
            if (match) {
                result.branch.ahead = parseInt(match[1], 10);
                result.branch.behind = parseInt(match[2], 10);
            }
        } else if (line.startsWith('# stash ')) {
            const match = STASH_REGEX.exec(line);
            if (match) result.stashCount = parseInt(match[1], 10);
        }
        // Ordinary changed files (1 ...)
        else if (line.startsWith('1 ')) {
            const match = ORDINARY_CHANGE_REGEX.exec(line);
            if (match) {
                const entry = parseOrdinaryChange(match);
                if (entry) {
                    result.files.push(entry);
                    categorizeFileV2(result, entry);
                }
            }
        }
        // Renamed/copied files (2 ...)
        else if (line.startsWith('2 ')) {
            const match = RENAME_COPY_REGEX.exec(line);
            if (match) {
                const entry = parseRenameCopy(match);
                if (entry) {
                    result.files.push(entry);
                    categorizeFileV2(result, entry);
                }
            }
        }
        // Unmerged files (u ...)
        else if (line.startsWith('u ')) {
            const match = UNMERGED_REGEX.exec(line);
            if (match) {
                const entry = parseUnmerged(match);
                if (entry) {
                    result.files.push(entry);
                    categorizeFileV2(result, entry);
                }
            }
        }
        // Untracked files (? ...)
        else if (line.startsWith('? ')) {
            const match = UNTRACKED_REGEX.exec(line);
            if (match) result.not_added.push(match[1]);
        }
        // Ignored files (! ...)
        else if (line.startsWith('! ')) {
            const match = IGNORED_REGEX.exec(line);
            if (match) result.ignored.push(match[1]);
        }
    }

    return result;
}

function parseOrdinaryChange(matches: (string | undefined)[]): GitFileEntryV2 | null {
    if (!matches[1] || !matches[2] || !matches[9]) return null;
    
    return {
        index: matches[1],
        working_dir: matches[2],
        submoduleState: matches[3],
        modeHead: matches[4],
        modeIndex: matches[5],
        modeWorktree: matches[6],
        hashHead: matches[7],
        hashIndex: matches[8],
        path: matches[9]
    };
}

function parseRenameCopy(matches: (string | undefined)[]): GitFileEntryV2 | null {
    if (!matches[1] || !matches[2] || !matches[11] || !matches[12]) return null;
    
    return {
        index: matches[1],
        working_dir: matches[2],
        submoduleState: matches[3],
        modeHead: matches[4],
        modeIndex: matches[5],
        modeWorktree: matches[6],
        hashHead: matches[7],
        hashIndex: matches[8],
        renameScore: parseInt(matches[10] || '0', 10),
        from: matches[11],
        path: matches[12]
    };
}

function parseUnmerged(matches: (string | undefined)[]): GitFileEntryV2 | null {
    if (!matches[1] || !matches[2] || !matches[11]) return null;
    
    return {
        index: matches[1],
        working_dir: matches[2],
        submoduleState: matches[3],
        modeHead: matches[4], // stage 1
        modeIndex: matches[5], // stage 2
        modeWorktree: matches[7], // worktree mode
        hashHead: matches[8], // stage 1 hash
        hashIndex: matches[9], // stage 2 hash
        path: matches[11]
    };
}

function categorizeFileV2(summary: GitStatusSummaryV2, entry: GitFileEntryV2): void {
    const { index, working_dir, path } = entry;

    // Handle staged changes (index column)
    if (index !== ' ' && index !== '.' && index !== '?') {
        summary.staged.push(path);
        
        switch (index) {
            case 'A':
                summary.created.push(path);
                break;
            case 'D':
                summary.deleted.push(path);
                break;
            case 'R':
            case 'C':
                summary.renamed.push(path);
                break;
            case 'M':
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
    if (working_dir !== ' ' && working_dir !== '.') {
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
            case 'C':
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
 * Count files by their status (compatible with v1 interface)
 */
export function getStatusCountsV2(summary: GitStatusSummaryV2): {
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
        total: summary.files.length + summary.not_added.length
    };
}

/**
 * Check if repository has any changes (compatible with v1 interface)
 */
export function isDirtyV2(summary: GitStatusSummaryV2): boolean {
    return summary.files.length > 0 || summary.not_added.length > 0;
}

/**
 * Get current branch name from v2 summary
 */
export function getCurrentBranchV2(summary: GitStatusSummaryV2): string | null {
    const head = summary.branch.head;
    return (head && head !== '(detached)' && head !== '(initial)') ? head : null;
}

/**
 * Check if branch is tracking an upstream
 */
export function hasUpstreamV2(summary: GitStatusSummaryV2): boolean {
    return !!(summary.branch.upstream);
}

/**
 * Get ahead/behind counts relative to upstream
 */
export function getTrackingInfoV2(summary: GitStatusSummaryV2): { ahead: number; behind: number } | null {
    if (!hasUpstreamV2(summary)) return null;
    
    return {
        ahead: summary.branch.ahead || 0,
        behind: summary.branch.behind || 0
    };
}