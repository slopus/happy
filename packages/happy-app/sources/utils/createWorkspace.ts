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

    // Generate workspace-level CLAUDE.md and AGENTS.md with @import references
    await generateWorkspaceConfigFiles(machineId, absoluteWorkspacePath, createdRepos);

    return { success: true, workspaceName, workspacePath: absoluteWorkspacePath, repos: createdRepos };
}

/**
 * Generate workspace-level CLAUDE.md and AGENTS.md files that @import
 * from each repo's corresponding file. Follows vibe-kanban's pattern:
 * only creates if the file doesn't already exist, and only if at least
 * one repo has the source file. Best-effort — failures don't block workspace creation.
 */
async function generateWorkspaceConfigFiles(
    machineId: string,
    workspacePath: string,
    repos: WorkspaceRepo[],
): Promise<void> {
    const configFiles = ['CLAUDE.md', 'AGENTS.md'];

    for (const configFile of configFiles) {
        try {
            // Skip if workspace already has this file
            const existsResult = await machineBash(
                machineId,
                `test -f ${shellEscape(workspacePath + '/' + configFile)}`,
                '/',
            );
            if (existsResult.success) continue;

            // Check which repos have this file
            const reposWithFile: string[] = [];
            for (const repo of repos) {
                if (!repo.displayName) continue;
                const checkResult = await machineBash(
                    machineId,
                    `test -f ${shellEscape(repo.path + '/' + configFile)}`,
                    '/',
                );
                if (checkResult.success) {
                    reposWithFile.push(repo.displayName);
                }
            }

            // Only create if at least one repo has the file
            if (reposWithFile.length === 0) continue;

            const content = reposWithFile.map(name => `@${name}/${configFile}`).join('\n') + '\n';
            await machineBash(
                machineId,
                `printf '%s' ${shellEscape(content)} > ${shellEscape(workspacePath + '/' + configFile)}`,
                '/',
            );
        } catch {
            // Best-effort: don't fail workspace creation
        }
    }
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
