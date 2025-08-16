/**
 * Git status file-level functionality
 * Provides detailed git status with file-level changes and line statistics
 */

import { sessionBash } from './ops';
import { storage } from './storage';

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

        // Parse the results
        const branchName = branchResult.success ? branchResult.stdout.trim() : null;
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
 * Parse git status and diff outputs into structured file data
 */
function parseGitStatusFiles(
    branchName: string | null,
    statusOutput: string,
    diffStatOutput: string,
    stagedDiffStatOutput: string
): GitStatusFiles {
    const statusLines = statusOutput.trim().split('\n').filter(line => line.length > 0);
    
    // Parse diff statistics for line changes
    const unstagedStats = parseDiffStats(diffStatOutput);
    const stagedStats = parseDiffStats(stagedDiffStatOutput);

    const stagedFiles: GitFileStatus[] = [];
    const unstagedFiles: GitFileStatus[] = [];

    for (const line of statusLines) {
        if (line.length < 3) continue;
        
        const indexStatus = line[0]; // Staged status
        const workingStatus = line[1]; // Working directory status
        const fileName = line.slice(3); // File path

        // Handle renamed files (format: "R  old_name -> new_name")
        let filePath = fileName;
        let oldPath: string | undefined;
        
        if (indexStatus === 'R' || workingStatus === 'R') {
            const renameParts = fileName.split(' -> ');
            if (renameParts.length === 2) {
                oldPath = renameParts[0];
                filePath = renameParts[1];
            }
        }

        const parts = filePath.split('/');
        const fileNameOnly = parts[parts.length - 1] || filePath;
        const filePathOnly = parts.slice(0, -1).join('/');

        // Create file status for staged changes
        if (indexStatus !== ' ' && indexStatus !== '?') {
            const status = getFileStatus(indexStatus);
            const stats = stagedStats[filePath] || { added: 0, removed: 0 };
            
            stagedFiles.push({
                fileName: fileNameOnly,
                filePath: filePathOnly,
                fullPath: filePath,
                status,
                isStaged: true,
                linesAdded: stats.added,
                linesRemoved: stats.removed,
                oldPath
            });
        }

        // Create file status for unstaged changes
        if (workingStatus !== ' ') {
            const status = getFileStatus(workingStatus);
            const stats = unstagedStats[filePath] || { added: 0, removed: 0 };
            
            unstagedFiles.push({
                fileName: fileNameOnly,
                filePath: filePathOnly,
                fullPath: filePath,
                status,
                isStaged: false,
                linesAdded: stats.added,
                linesRemoved: stats.removed,
                oldPath
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
 * Parse git diff --numstat output into a map of file paths to line statistics
 */
function parseDiffStats(diffStatOutput: string): Record<string, { added: number; removed: number }> {
    const stats: Record<string, { added: number; removed: number }> = {};
    
    const lines = diffStatOutput.trim().split('\n').filter(line => line.length > 0);
    
    for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
            const added = parseInt(parts[0], 10);
            const removed = parseInt(parts[1], 10);
            const filePath = parts[2];
            
            stats[filePath] = {
                added: !isNaN(added) ? added : 0,
                removed: !isNaN(removed) ? removed : 0
            };
        }
    }
    
    return stats;
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