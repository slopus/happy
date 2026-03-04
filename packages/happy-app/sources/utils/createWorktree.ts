/**
 * Create and list Git worktrees
 */

import { machineBash } from '@/sync/ops';
import { generateWorktreeName } from './generateWorktreeName';

export async function createWorktree(
    machineId: string,
    basePath: string
): Promise<{
    success: boolean;
    worktreePath: string;
    branchName: string;
    error?: string;
}> {
    const name = generateWorktreeName();
    
    // Check if it's a git repository
    const gitCheck = await machineBash(
        machineId,
        'git rev-parse --git-dir',
        basePath
    );
    
    if (!gitCheck.success) {
        return {
            success: false,
            worktreePath: '',
            branchName: '',
            error: 'Not a Git repository'
        };
    }
    
    // Create the worktree with new branch
    const worktreePath = `.dev/worktree/${name}`;
    let result = await machineBash(
        machineId,
        `git worktree add -b ${name} ${worktreePath}`,
        basePath
    );
    
    // If worktree exists, try with a different name
    if (!result.success && result.stderr.includes('already exists')) {
        // Try up to 3 times with numbered suffixes
        for (let i = 2; i <= 4; i++) {
            const newName = `${name}-${i}`;
            const newWorktreePath = `.dev/worktree/${newName}`;
            result = await machineBash(
                machineId,
                `git worktree add -b ${newName} ${newWorktreePath}`,
                basePath
            );
            
            if (result.success) {
                return {
                    success: true,
                    worktreePath: `${basePath}/${newWorktreePath}`,
                    branchName: newName,
                    error: undefined
                };
            }
        }
    }
    
    if (result.success) {
        return {
            success: true,
            worktreePath: `${basePath}/${worktreePath}`,
            branchName: name,
            error: undefined
        };
    }
    
    return {
        success: false,
        worktreePath: '',
        branchName: '',
        error: result.stderr || 'Failed to create worktree'
    };
}

export interface WorktreeInfo {
    path: string;
    branch: string;
}

export async function listWorktrees(
    machineId: string,
    basePath: string
): Promise<WorktreeInfo[]> {
    const result = await machineBash(
        machineId,
        'git worktree list --porcelain',
        basePath
    );
    if (!result.success) return [];

    // Porcelain output has blocks separated by blank lines.
    // First block is the main worktree — skip it.
    const blocks = result.stdout.split('\n\n').slice(1);
    const worktrees: WorktreeInfo[] = [];

    for (const block of blocks) {
        let path = '';
        let branch = '';
        for (const line of block.split('\n')) {
            if (line.startsWith('worktree ')) {
                path = line.slice('worktree '.length);
            } else if (line.startsWith('branch refs/heads/')) {
                branch = line.slice('branch refs/heads/'.length);
            }
        }
        if (path) {
            worktrees.push({ path, branch: branch || path });
        }
    }

    return worktrees;
}