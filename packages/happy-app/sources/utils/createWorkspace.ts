/**
 * Create a multi-repo workspace with git worktrees for each repo.
 */

import { machineBash } from '@/sync/ops';
import { generateWorktreeName } from '@/utils/generateWorktreeName';
import { shellEscape } from '@/utils/shellEscape';
import type { RegisteredRepo, WorkspaceRepo } from '@/utils/workspaceRepos';

/** Only allow safe characters in path components (no slashes, no ..) */
function isSafePathComponent(name: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(name) && name.length > 0 && name.length < 256;
}

function isRegisteredRepo(repo: WorkspaceRepoInput['repo']): repo is RegisteredRepo {
    return 'id' in repo;
}

export interface WorkspaceRepoInput {
    repo: RegisteredRepo | { path: string; displayName: string };
    targetBranch?: string;
}

interface CreateWorkspaceResult {
    success: boolean;
    workspaceName: string;
    workspacePath: string;
    repos: WorkspaceRepo[];
    error?: string;
}

/**
 * Create a multi-repo workspace with git worktrees for each repo.
 *
 * For each repo input, creates a git worktree inside a shared workspace
 * directory (~/.happy/workspaces/<name>). On failure, rolls back all
 * previously created worktrees and removes the workspace directory.
 */
export async function createWorkspace(
    machineId: string,
    repoInputs: WorkspaceRepoInput[],
): Promise<CreateWorkspaceResult> {
    const workspaceName = generateWorktreeName();
    // ~ is left unescaped so the shell expands it; workspaceName is safe (adjective-noun)
    const workspacePath = `~/.happy/workspaces/${shellEscape(workspaceName)}`;

    // Create workspace directory
    // Use '/' as cwd to bypass daemon path validation (the command itself uses absolute/~ paths)
    const mkdirResult = await machineBash(machineId, `mkdir -p ${workspacePath}`, '/');
    if (!mkdirResult.success) {
        return { success: false, workspaceName, workspacePath, repos: [], error: 'Failed to create workspace directory' };
    }

    // Resolve ~ to absolute path via realpath
    const resolveResult = await machineBash(machineId, `realpath ${workspacePath}`, '/');
    if (!resolveResult.success || !resolveResult.stdout.trim()) {
        await machineBash(machineId, `rm -rf ${workspacePath}`, '/');
        return { success: false, workspaceName, workspacePath: '', repos: [], error: 'Failed to resolve workspace path' };
    }
    const absoluteWorkspacePath = resolveResult.stdout.trim();

    const createdRepos: WorkspaceRepo[] = [];

    for (const input of repoInputs) {
        const { repo, targetBranch } = input;

        // Validate displayName as a safe path component
        if (!isSafePathComponent(repo.displayName)) {
            await rollbackCreatedRepos(machineId, createdRepos, workspaceName, absoluteWorkspacePath);
            return {
                success: false, workspaceName, workspacePath: absoluteWorkspacePath, repos: [],
                error: `Invalid repo display name: ${repo.displayName}`,
            };
        }

        const worktreePath = `${absoluteWorkspacePath}/${repo.displayName}`;

        // Create worktree with a branch named after the workspace
        const targetArg = targetBranch ? ` ${shellEscape(targetBranch)}` : '';
        const cmd = `git worktree add -b ${shellEscape(workspaceName)} ${shellEscape(worktreePath)}${targetArg}`;
        const result = await machineBash(machineId, cmd, repo.path);

        if (!result.success) {
            await rollbackCreatedRepos(machineId, createdRepos, workspaceName, absoluteWorkspacePath);
            return {
                success: false, workspaceName, workspacePath: absoluteWorkspacePath, repos: [],
                error: `Failed to create worktree for ${repo.displayName}: ${result.stderr}`,
            };
        }

        // Copy files if configured (RegisteredRepo has copyFiles field)
        if (isRegisteredRepo(repo) && repo.copyFiles) {
            const files = repo.copyFiles.split(',').map(f => f.trim()).filter(Boolean);
            for (const file of files) {
                // Skip files with path traversal
                if (file.includes('..')) continue;
                await machineBash(
                    machineId,
                    `mkdir -p "$(dirname ${shellEscape(worktreePath + '/' + file)})" && cp ${shellEscape(repo.path + '/' + file)} ${shellEscape(worktreePath + '/' + file)} 2>/dev/null`,
                    repo.path,
                );
            }
        }

        createdRepos.push({
            repoId: isRegisteredRepo(repo) ? repo.id : undefined,
            path: worktreePath,
            basePath: repo.path,
            branchName: workspaceName,
            targetBranch,
            displayName: repo.displayName,
        });
    }

    return { success: true, workspaceName, workspacePath: absoluteWorkspacePath, repos: createdRepos };
}

/** Roll back previously created worktrees and remove workspace directory */
async function rollbackCreatedRepos(
    machineId: string,
    createdRepos: WorkspaceRepo[],
    workspaceName: string,
    absoluteWorkspacePath: string,
): Promise<void> {
    for (const created of createdRepos) {
        await machineBash(
            machineId,
            `git worktree remove --force ${shellEscape(created.path)} 2>/dev/null; git branch -D ${shellEscape(workspaceName)} 2>/dev/null`,
            created.basePath,
        );
    }
    await machineBash(machineId, `rm -rf ${shellEscape(absoluteWorkspacePath)}`, '/');
}
