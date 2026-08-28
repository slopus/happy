/**
 * The project key the session list stars by. The path helpers themselves live
 * in `utils/worktreePaths` (upstream's dependency-free module) and are
 * re-exported here so this file stays the single place the star key is defined
 * — keeping the key logic out of an upstream file it would otherwise conflict
 * with on every rebase.
 */
export { WORKTREE_DIR, WORKTREE_PATH_MARKER, isWorktreePath, getRepoPath } from './worktreePaths';

import { getRepoPath, isWorktreePath } from './worktreePaths';

/**
 * Identifies a project (a machine plus a path on it). Sessions sharing a
 * directory on the same machine share one key — what the compact session list
 * groups by and what `settings.starredProjects` stores.
 */
export const projectKey = (machineId: string, path: string): string => `${machineId}:${path}`;

/**
 * The key a path is starred under. Worktrees are not starred independently:
 * they inherit the star of the repo they belong to, so starring a repo lifts
 * every worktree of it, and a worktree cannot be starred on its own.
 */
export function projectStarKey(machineId: string, path: string): string {
    return projectKey(machineId, isWorktreePath(path) ? getRepoPath(path) : path);
}
