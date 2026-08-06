/**
 * Git worktree operations: create, list, remove
 */

import { machineBash } from '@/sync/ops';

/** Relative path prefix where worktrees are stored inside a repo */
export const WORKTREE_DIR = '.dev/worktree';

/** Absolute path marker used to detect worktree paths */
export const WORKTREE_PATH_MARKER = `/${WORKTREE_DIR}/`;

// --- Name generation ---

const adjectives = [
    'clever', 'happy', 'swift', 'bright', 'calm',
    'bold', 'quiet', 'brave', 'wise', 'eager',
    'gentle', 'quick', 'sharp', 'smooth', 'fresh'
];

const nouns = [
    'ocean', 'forest', 'cloud', 'star', 'river',
    'mountain', 'valley', 'bridge', 'beacon', 'harbor',
    'garden', 'meadow', 'canyon', 'island', 'desert'
];

function generateWorktreeName(): string {
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adjective}-${noun}`;
}

// --- Operations ---

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
        // exitCode -1 means the RPC call itself failed (network, daemon offline, etc.)
        // Don't mask it as "Not a Git repository"
        const isRpcFailure = gitCheck.exitCode === -1;
        return {
            success: false,
            worktreePath: '',
            branchName: '',
            error: isRpcFailure
                ? (gitCheck.stderr || 'Failed to connect to machine')
                : 'Not a Git repository'
        };
    }

    // Create the worktree with new branch
    const worktreePath = `${WORKTREE_DIR}/${name}`;
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
            const newWorktreePath = `${WORKTREE_DIR}/${newName}`;
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

/**
 * Kill any process whose working directory is inside the worktree.
 *
 * `git worktree remove --force` deletes the directory even while a process is
 * still cwd'd into it — most often a happy session that got orphaned when its
 * daemon restarted. That orphan then lives on inside a now-deleted directory,
 * holding its server socket open and re-reporting the session as `active`
 * forever, so the session can never be archived from the app. We therefore
 * stop those processes *before* removing the directory.
 *
 * Portable across the machine's OS: Linux reads /proc/<pid>/cwd, macOS falls
 * back to lsof (resolved by absolute path so a stripped PATH still finds it).
 * The worktree path is canonicalised (pwd -P) so a symlinked parent still
 * matches, and the match is anchored to the worktree dir or a subdir of it —
 * never a sibling that merely shares a name prefix. SIGTERM lets the happy CLI
 * shut its session down cleanly. Entirely best-effort: a failure here must
 * never block the worktree removal itself.
 */
async function killProcessesInWorktree(
    machineId: string,
    worktreePath: string,
    cwd: string
): Promise<void> {
    const script = [
        `WT='${worktreePath}'`,
        `WT=$(cd "$WT" 2>/dev/null && pwd -P || printf %s "$WT")`,
        `if [ -d /proc ]; then`,
        `  for d in /proc/[0-9]*; do c=$(readlink "$d/cwd" 2>/dev/null) || continue; case "$c" in "$WT"|"$WT"/*) kill "$(basename "$d")" 2>/dev/null || true;; esac; done`,
        `else`,
        `  L=$(command -v lsof || echo /usr/sbin/lsof)`,
        `  "$L" -d cwd -Fpn 2>/dev/null | awk -v wt="$WT" '/^p/{pid=substr($0,2)} /^n/{p=substr($0,2); if(p==wt||index(p,wt"/")==1)print pid}' | while read -r pid; do kill "$pid" 2>/dev/null || true; done`,
        `fi`,
        `true`,
    ].join('\n');
    await machineBash(machineId, script, cwd).catch(() => {});
}

export async function removeWorktree(
    machineId: string,
    worktreePath: string
): Promise<{ success: boolean; error?: string }> {
    const idx = worktreePath.indexOf(WORKTREE_PATH_MARKER);
    if (idx === -1) {
        return { success: false, error: 'Not a worktree path' };
    }
    const basePath = worktreePath.slice(0, idx);

    // Stop processes still running inside the worktree before --force deletes
    // it out from under them (see killProcessesInWorktree).
    await killProcessesInWorktree(machineId, worktreePath, basePath);

    const result = await machineBash(
        machineId,
        `git worktree remove ${worktreePath} --force`,
        basePath
    );
    return {
        success: result.success,
        error: result.success ? undefined : (result.stderr || 'Failed to remove worktree'),
    };
}

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

/** Extract the worktree name from a worktree path, or null if not a worktree */
export function getWorktreeName(path: string): string | null {
    const idx = path.indexOf(WORKTREE_PATH_MARKER);
    if (idx === -1) return null;
    return path.slice(idx + WORKTREE_PATH_MARKER.length);
}
