/**
 * Pure project-path logic: worktree path shapes and the project key the session
 * list groups and stars by. Deliberately dependency-free — `utils/worktree.ts`
 * reaches the machine over RPC, which would drag React Native into anything
 * that imports it (including unit tests). It re-exports the path helpers below,
 * so existing import sites keep working.
 */

/** Relative path prefix where worktrees are stored inside a repo */
export const WORKTREE_DIR = '.dev/worktree';

/** Absolute path marker used to detect worktree paths */
export const WORKTREE_PATH_MARKER = `/${WORKTREE_DIR}/`;

/** Check if a path is inside a worktree */
export function isWorktreePath(path: string): boolean {
    return path.includes(WORKTREE_PATH_MARKER);
}

/** Extract the main repository checkout path from a possibly-worktree path */
export function getRepoPath(path: string): string {
    const idx = path.indexOf(WORKTREE_PATH_MARKER);
    if (idx === -1) return path;
    return path.slice(0, idx);
}

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
