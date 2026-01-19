/**
 * Create a Git worktree with automatic branch creation
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