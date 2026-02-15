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

/** Get local branch names in the base repository */
export async function getLocalBranches(
    machineId: string,
    basePath: string
): Promise<string[]> {
    const result = await machineBash(
        machineId,
        "git branch --list --format='%(refname:short)'",
        basePath
    );
    if (!result.success || !result.stdout.trim()) return [];
    return result.stdout.trim().split('\n').filter(Boolean);
}

/** Get the current branch name of the base repository */
export async function getCurrentBranch(
    machineId: string,
    basePath: string
): Promise<string | null> {
    const result = await machineBash(machineId, 'git branch --show-current', basePath);
    if (!result.success || !result.stdout.trim()) return null;
    return result.stdout.trim();
}

/** Merge worktree branch into a specified target branch */
export async function mergeWorktreeBranch(
    machineId: string,
    basePath: string,
    branchName: string,
    targetBranch: string
): Promise<{ success: boolean; error?: string; hasConflicts?: boolean }> {
    if (!isValidGitRef(branchName) || !isValidGitRef(targetBranch)) {
        return { success: false, error: 'Invalid branch name' };
    }

    // Remember current branch so we can restore after merge
    const currentBranchResult = await machineBash(machineId, 'git branch --show-current', basePath);
    const originalBranch = currentBranchResult.success ? currentBranchResult.stdout.trim() : null;
    const needsCheckout = originalBranch !== targetBranch;

    // Switch to target branch if needed
    if (needsCheckout) {
        const checkout = await machineBash(machineId, `git checkout '${shellEscape(targetBranch)}'`, basePath);
        if (!checkout.success) {
            return { success: false, error: checkout.stderr || `Failed to checkout ${targetBranch}` };
        }
    }

    const merge = await machineBash(machineId, `git merge '${shellEscape(branchName)}' --no-edit`, basePath);
    if (!merge.success) {
        const hasConflicts = merge.stdout.includes('CONFLICT') || merge.stderr.includes('CONFLICT');
        if (hasConflicts) {
            await machineBash(machineId, 'git merge --abort', basePath);
        }
        // Restore original branch
        if (needsCheckout && originalBranch) {
            await machineBash(machineId, `git checkout '${shellEscape(originalBranch)}'`, basePath);
        }
        if (hasConflicts) {
            return { success: false, hasConflicts: true, error: 'Merge has conflicts' };
        }
        return { success: false, error: merge.stderr || 'Failed to merge branch' };
    }

    // Restore original branch after successful merge
    if (needsCheckout && originalBranch) {
        await machineBash(machineId, `git checkout '${shellEscape(originalBranch)}'`, basePath);
    }

    return { success: true };
}

/** Create a PR for the worktree branch using gh CLI */
export async function createWorktreePR(
    machineId: string,
    worktreePath: string,
    branchName: string,
    title?: string,
    baseBranch?: string,
): Promise<{ success: boolean; prUrl?: string; error?: string }> {
    if (!isValidGitRef(branchName)) {
        return { success: false, error: 'Invalid branch name' };
    }
    if (baseBranch && !isValidGitRef(baseBranch)) {
        return { success: false, error: 'Invalid base branch name' };
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
    const baseArg = baseBranch ? ` --base '${shellEscape(baseBranch)}'` : '';
    const result = await machineBash(
        machineId,
        `gh pr create --head '${shellEscape(branchName)}'${baseArg} --title '${shellEscape(prTitle)}' --body 'Created from Happy mobile app'`,
        worktreePath
    );
    if (!result.success) {
        return { success: false, error: result.stderr || 'Failed to create PR' };
    }

    const prUrl = result.stdout.trim();
    return { success: true, prUrl };
}

/** Get the PR diff for a worktree branch using gh CLI */
export async function getWorktreePRDiff(
    machineId: string,
    worktreePath: string,
    branchName: string
): Promise<{ success: boolean; diff?: string; error?: string }> {
    if (!isValidGitRef(branchName)) {
        return { success: false, error: 'Invalid branch name' };
    }
    const result = await machineBash(
        machineId,
        `gh pr diff '${shellEscape(branchName)}'`,
        worktreePath
    );
    if (!result.success || result.exitCode !== 0) {
        return { success: false, error: result.stderr || 'Failed to get PR diff' };
    }
    return { success: true, diff: result.stdout };
}

/** Post a comment on the PR using gh CLI (uses user's gh auth on the machine) */
export async function postPRComment(
    machineId: string,
    worktreePath: string,
    branchName: string,
    comment: string
): Promise<{ success: boolean; error?: string }> {
    if (!isValidGitRef(branchName)) {
        return { success: false, error: 'Invalid branch name' };
    }
    const result = await machineBash(
        machineId,
        `gh pr comment '${shellEscape(branchName)}' --body '${shellEscape(comment)}'`,
        worktreePath
    );
    if (!result.success || result.exitCode !== 0) {
        return { success: false, error: result.stderr || 'Failed to post comment' };
    }
    return { success: true };
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
