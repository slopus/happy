/**
 * Git status file-level functionality
 * Provides detailed git status with file-level changes and line statistics
 */

import { sessionBash } from './ops';
import { storage } from './storage';
import { parseStatusSummaryV2, getCurrentBranchV2 } from './git-parsers/parseStatusV2';
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

        // Get git status in porcelain v2 format (includes branch info and repo check)
        // --untracked-files=all ensures we get individual files, not directories
        const statusResult = await sessionBash(sessionId, {
            command: 'git status --porcelain=v2 --branch --untracked-files=all',
            cwd: session.metadata.path,
            timeout: 10000
        });

        if (!statusResult.success || statusResult.exitCode !== 0) {
            // Not a git repo or git command failed
            return null;
        }

        // Get combined diff statistics for both staged and unstaged changes
        const diffStatResult = await sessionBash(sessionId, {
            command: 'git diff --numstat HEAD && echo "---STAGED---" && git diff --cached --numstat',
            cwd: session.metadata.path,
            timeout: 10000
        });

        // Parse the results using v2 parser
        const statusOutput = statusResult.stdout;
        const diffOutput = diffStatResult.success ? diffStatResult.stdout : '';

        return parseGitStatusFilesV2(statusOutput, diffOutput);

    } catch (error) {
        console.error('Error fetching git status files for session', sessionId, ':', error);
        return null;
    }
}

/**
 * Parse git status v2 and diff outputs into structured file data
 */
function parseGitStatusFilesV2(
    statusOutput: string,
    combinedDiffOutput: string
): GitStatusFiles {
    // Parse status using v2 parser
    const statusSummary = parseStatusSummaryV2(statusOutput);
    const branchName = getCurrentBranchV2(statusSummary);
    
    // Parse combined diff statistics
    const [unstagedOutput = '', stagedOutput = ''] = combinedDiffOutput.split('---STAGED---');
    const unstagedDiff = parseNumStat(unstagedOutput.trim());
    const stagedDiff = parseNumStat(stagedOutput.trim());
    const unstagedStats = createDiffStatsMap(unstagedDiff);
    const stagedStats = createDiffStatsMap(stagedDiff);

    const stagedFiles: GitFileStatus[] = [];
    const unstagedFiles: GitFileStatus[] = [];

    for (const file of statusSummary.files) {
        const parts = file.path.split('/');
        const fileNameOnly = parts[parts.length - 1] || file.path;
        const filePathOnly = parts.slice(0, -1).join('/');

        // Create file status for staged changes
        if (file.index !== ' ' && file.index !== '.' && file.index !== '?') {
            const status = getFileStatusV2(file.index);
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
        if (file.working_dir !== ' ' && file.working_dir !== '.') {
            const status = getFileStatusV2(file.working_dir);
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

    // Add untracked files to unstaged
    for (const untrackedPath of statusSummary.not_added) {
        // Handle both files and directories (directories have trailing slash)
        const isDirectory = untrackedPath.endsWith('/');
        const cleanPath = isDirectory ? untrackedPath.slice(0, -1) : untrackedPath;
        const parts = cleanPath.split('/');
        const fileNameOnly = parts[parts.length - 1] || cleanPath;
        const filePathOnly = parts.slice(0, -1).join('/');
        
        // Skip directory entries since we're using --untracked-files=all
        // This is a fallback in case git still reports directories
        if (isDirectory) {
            console.warn(`Unexpected directory in untracked files: ${untrackedPath}`);
            continue;
        }
        
        unstagedFiles.push({
            fileName: fileNameOnly,
            filePath: filePathOnly,
            fullPath: cleanPath,
            status: 'untracked',
            isStaged: false,
            linesAdded: 0,
            linesRemoved: 0
        });
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
 * Convert git status character to readable status (v2 format)
 */
function getFileStatusV2(statusChar: string): GitFileStatus['status'] {
    switch (statusChar) {
        case 'M': return 'modified';
        case 'A': return 'added';
        case 'D': return 'deleted';
        case 'R': 
        case 'C': return 'renamed';
        case '?': return 'untracked';
        default: return 'modified';
    }
}