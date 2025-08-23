/**
 * Git status file-level functionality
 * Provides detailed git status with file-level changes and line statistics
 */

import { sessionBash } from './ops';
import { storage } from './storage';
import { parseStatusSummary } from './git-parsers/parseStatus';
import { parseCurrentBranch } from './git-parsers/parseBranch';
import { parseNumStat, createDiffStatsMap } from './git-parsers/parseDiff';

export interface GitFileStatus {
    fileName: string;
    filePath: string;
    fullPath: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
    isStaged: boolean;
    linesAdded: number;
    linesRemoved: number;
    oldPath?: string; // For renamed files
}

export interface GitStatusFiles {
    stagedFiles: GitFileStatus[];
    unstagedFiles: GitFileStatus[];
    branch: string | null;
    totalStaged: number;
    totalUnstaged: number;
}

/**
 * Fetch detailed git status with file-level information
 */
export async function getGitStatusFiles(sessionId: string): Promise<GitStatusFiles | null> {
    try {
        // Check if we have a session with valid metadata
        const session = storage.getState().sessions[sessionId];
        if (!session?.metadata?.path) {
            return null;
        }

        // First check if we're in a git repository
        const gitCheckResult = await sessionBash(sessionId, {
            command: 'git rev-parse --is-inside-work-tree',
            cwd: session.metadata.path,
            timeout: 5000
        });

        if (!gitCheckResult.success || gitCheckResult.exitCode !== 0) {
            return null;
        }

        // Get current branch name
        const branchResult = await sessionBash(sessionId, {
            command: 'git branch --show-current',
            cwd: session.metadata.path,
            timeout: 5000
        });

        // Get git status in porcelain format
        const statusResult = await sessionBash(sessionId, {
            command: 'git status --porcelain',
            cwd: session.metadata.path,
            timeout: 10000
        });

        if (!statusResult.success) {
            console.error('Failed to get git status:', statusResult.error);
            return null;
        }

        // Get git diff statistics for unstaged changes
        const diffStatResult = await sessionBash(sessionId, {
            command: 'git diff --numstat',
            cwd: session.metadata.path,
            timeout: 10000
        });

        // Get git diff statistics for staged changes
        const stagedDiffStatResult = await sessionBash(sessionId, {
            command: 'git diff --cached --numstat',
            cwd: session.metadata.path,
            timeout: 10000
        });

        // Parse the results using simple-git parsers
        const branchName = branchResult.success ? parseCurrentBranch(branchResult.stdout) : null;
        const statusOutput = statusResult.stdout;
        const diffStatOutput = diffStatResult.success ? diffStatResult.stdout : '';
        const stagedDiffStatOutput = stagedDiffStatResult.success ? stagedDiffStatResult.stdout : '';

        return parseGitStatusFiles(branchName, statusOutput, diffStatOutput, stagedDiffStatOutput);

    } catch (error) {
        console.error('Error fetching git status files for session', sessionId, ':', error);
        return null;
    }
}

/**
 * Parse git status and diff outputs into structured file data using simple-git parsers
 */
function parseGitStatusFiles(
    branchName: string | null,
    statusOutput: string,
    diffStatOutput: string,
    stagedDiffStatOutput: string
): GitStatusFiles {
    // Parse status using simple-git parser
    const statusSummary = parseStatusSummary(statusOutput);
    
    // Parse diff statistics
    const unstagedDiff = parseNumStat(diffStatOutput);
    const stagedDiff = parseNumStat(stagedDiffStatOutput);
    const unstagedStats = createDiffStatsMap(unstagedDiff);
    const stagedStats = createDiffStatsMap(stagedDiff);

    const stagedFiles: GitFileStatus[] = [];
    const unstagedFiles: GitFileStatus[] = [];

    for (const file of statusSummary.files) {
        const parts = file.path.split('/');
        const fileNameOnly = parts[parts.length - 1] || file.path;
        const filePathOnly = parts.slice(0, -1).join('/');

        // Create file status for staged changes
        if (file.index !== ' ' && file.index !== '?') {
            const status = getFileStatus(file.index);
            const stats = stagedStats[file.path] || { added: 0, removed: 0, binary: false };
            
            stagedFiles.push({
                fileName: fileNameOnly,
                filePath: filePathOnly,
                fullPath: file.path,
                status,
                isStaged: true,
                linesAdded: stats.added,
                linesRemoved: stats.removed,
                oldPath: file.from
            });
        }

        // Create file status for unstaged changes
        if (file.working_dir !== ' ') {
            const status = getFileStatus(file.working_dir);
            const stats = unstagedStats[file.path] || { added: 0, removed: 0, binary: false };
            
            unstagedFiles.push({
                fileName: fileNameOnly,
                filePath: filePathOnly,
                fullPath: file.path,
                status,
                isStaged: false,
                linesAdded: stats.added,
                linesRemoved: stats.removed,
                oldPath: file.from
            });
        }
    }

    return {
        stagedFiles,
        unstagedFiles,
        branch: branchName,
        totalStaged: stagedFiles.length,
        totalUnstaged: unstagedFiles.length
    };
}


/**
 * Convert git status character to readable status
 */
function getFileStatus(statusChar: string): GitFileStatus['status'] {
    switch (statusChar) {
        case 'M': return 'modified';
        case 'A': return 'added';
        case 'D': return 'deleted';
        case 'R': return 'renamed';
        case '?': return 'untracked';
        default: return 'modified';
    }
}