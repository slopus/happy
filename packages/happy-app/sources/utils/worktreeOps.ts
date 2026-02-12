/**
 * Worktree lifecycle operations.
 * All git commands execute remotely via machineBash.
 */

import { machineBash } from '@/sync/ops';
import type { Metadata } from '@/sync/storageTypes';

/** Validate a git ref name to prevent shell injection */
function isValidGitRef(name: string): boolean {
    return /^[a-zA-Z0-9._\/-]+$/.test(name) && name.length > 0 && name.length < 256;
}

/** Shell-escape a string for use in single quotes */
function shellEscape(s: string): string {
    return s.replace(/'/g, "'\\''");
}

/** Check if a session is a worktree session (detected by CLI at startup via git) */
export function isWorktreeSession(metadata: Metadata | null): boolean {
    if (!metadata) return false;
    return metadata.isWorktree === true;
}

/** Extract worktree info from metadata (set by CLI at startup via git) */
export function getWorktreeInfo(metadata: Metadata | null): { basePath: string; branchName: string } | null {
    if (!metadata) return null;
    if (metadata.worktreeBasePath && metadata.worktreeBranchName) {
        return { basePath: metadata.worktreeBasePath, branchName: metadata.worktreeBranchName };
    }
    return null;
}

/** Get the default branch name (main/master) of the repository */
export async function getBaseBranchName(
    machineId: string,
    basePath: string
): Promise<string> {
    // Try symbolic-ref first (most reliable)
    const symRef = await machineBash(
        machineId,
        'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s@^refs/remotes/origin/@@"',
        basePath
    );
    const name = symRef.stdout.trim();
    if (symRef.success && symRef.exitCode === 0 && name) {
        return name;
    }

    // Fallback: check if main or master exists
    const mainCheck = await machineBash(machineId, 'git rev-parse --verify main 2>/dev/null', basePath);
    if (mainCheck.success && mainCheck.exitCode === 0) return 'main';

    const masterCheck = await machineBash(machineId, 'git rev-parse --verify master 2>/dev/null', basePath);
    if (masterCheck.success && masterCheck.exitCode === 0) return 'master';

    return 'main';
}

/** Push the worktree branch to remote */
export async function pushWorktreeBranch(
    machineId: string,
    worktreePath: string,
    branchName: string
): Promise<{ success: boolean; error?: string }> {
    if (!isValidGitRef(branchName)) {
        return { success: false, error: 'Invalid branch name' };
    }
    const result = await machineBash(
        machineId,
        `git push -u origin '${shellEscape(branchName)}'`,
        worktreePath
    );
    if (!result.success) {
        return { success: false, error: result.stderr || 'Failed to push branch' };
    }
    return { success: true };
}

/** Merge worktree branch back into the base branch */
export async function mergeWorktreeBranch(
    machineId: string,
    basePath: string,
    branchName: string
): Promise<{ success: boolean; error?: string; hasConflicts?: boolean }> {
    if (!isValidGitRef(branchName)) {
        return { success: false, error: 'Invalid branch name' };
    }

    const baseBranch = await getBaseBranchName(machineId, basePath);

    // Remember current branch so we can restore on failure
    const currentBranchResult = await machineBash(machineId, 'git rev-parse --abbrev-ref HEAD', basePath);
    const originalBranch = currentBranchResult.success ? currentBranchResult.stdout.trim() : null;

    // Switch to base branch
    const checkout = await machineBash(machineId, `git checkout '${shellEscape(baseBranch)}'`, basePath);
    if (!checkout.success) {
        return { success: false, error: checkout.stderr || `Failed to checkout ${baseBranch}` };
    }

    // Merge
    const merge = await machineBash(machineId, `git merge '${shellEscape(branchName)}' --no-edit`, basePath);
    if (!merge.success) {
        const hasConflicts = merge.stdout.includes('CONFLICT') || merge.stderr.includes('CONFLICT');
        if (hasConflicts) {
            await machineBash(machineId, 'git merge --abort', basePath);
        }
        // Restore original branch
        if (originalBranch && originalBranch !== baseBranch) {
            await machineBash(machineId, `git checkout '${shellEscape(originalBranch)}'`, basePath);
        }
        if (hasConflicts) {
            return { success: false, hasConflicts: true, error: 'Merge has conflicts' };
        }
        return { success: false, error: merge.stderr || 'Failed to merge branch' };
    }

    return { success: true };
}

/** Create a PR for the worktree branch using gh CLI */
export async function createWorktreePR(
    machineId: string,
    worktreePath: string,
    branchName: string,
    title?: string,
): Promise<{ success: boolean; prUrl?: string; error?: string }> {
    if (!isValidGitRef(branchName)) {
        return { success: false, error: 'Invalid branch name' };
    }

    // Check if gh is installed
    const ghCheck = await machineBash(machineId, 'gh --version', worktreePath);
    if (!ghCheck.success) {
        return { success: false, error: 'gh_not_installed' };
    }

    // Push first
    const push = await pushWorktreeBranch(machineId, worktreePath, branchName);
    if (!push.success) {
        return { success: false, error: push.error };
    }

    // Create PR with safe quoting
    const prTitle = title || branchName;
    const result = await machineBash(
        machineId,
        `gh pr create --head '${shellEscape(branchName)}' --title '${shellEscape(prTitle)}' --body 'Created from Happy mobile app'`,
        worktreePath
    );
    if (!result.success) {
        return { success: false, error: result.stderr || 'Failed to create PR' };
    }

    const prUrl = result.stdout.trim();
    return { success: true, prUrl };
}

/** Clean up the worktree (remove worktree directory, preserve branch) */
export async function cleanupWorktree(
    machineId: string,
    basePath: string,
    branchName: string
): Promise<{ success: boolean; error?: string }> {
    if (!isValidGitRef(branchName)) {
        return { success: false, error: 'Invalid branch name' };
    }

    const worktreeDir = `.dev/worktree/${branchName}`;

    const result = await machineBash(
        machineId,
        `git worktree remove '${shellEscape(worktreeDir)}' --force`,
        basePath
    );

    if (!result.success) {
        if (result.stderr.includes('is not a working tree') || result.stderr.includes('No such file')) {
            return { success: true };
        }
        return { success: false, error: result.stderr || 'Failed to remove worktree' };
    }

    return { success: true };
}
