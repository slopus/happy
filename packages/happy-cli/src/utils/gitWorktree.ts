/**
 * Git-native worktree detection.
 *
 * Detects if the current working directory is a git worktree by comparing
 * `git rev-parse --git-dir` with `--git-common-dir`. When they differ,
 * the directory is a linked worktree (not the main working tree).
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

export interface WorktreeDetection {
    isWorktree: boolean;
    worktreeBasePath?: string;
    worktreeBranchName?: string;
}

/**
 * Detect if a directory is a git worktree.
 * Returns worktree info if it is, or `{ isWorktree: false }` otherwise.
 * Never throws — returns false on any error.
 */
export function detectGitWorktree(cwd: string): WorktreeDetection {
    try {
        const gitDir = execSync('git rev-parse --git-dir', {
            cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();

        const gitCommonDir = execSync('git rev-parse --git-common-dir', {
            cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();

        // Resolve to absolute paths for reliable comparison
        const absGitDir = resolve(cwd, gitDir);
        const absCommonDir = resolve(cwd, gitCommonDir);

        if (absGitDir === absCommonDir) {
            return { isWorktree: false };
        }

        // It's a worktree — derive base path and branch name
        const basePath = dirname(absCommonDir);

        const branchName = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();

        return {
            isWorktree: true,
            worktreeBasePath: basePath,
            worktreeBranchName: branchName || undefined,
        };
    } catch {
        return { isWorktree: false };
    }
}
