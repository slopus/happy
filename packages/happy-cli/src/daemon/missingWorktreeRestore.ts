import { execFile } from 'node:child_process';
import { access, open, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

/*
 * A resumable session is bound to its working directory: the agent's
 * transcript is keyed by that path and resume runs there. Managed worktrees
 * under `<repo>/.aplus/worktrees/` are deliberately disposable — Desktop's idle
 * sweep removes a standby session's worktree after 7 days and keeps the
 * branch so it can be recreated, and agents asked to "clean up worktrees"
 * remove their own. Without this, resume dies with ENOENT and the
 * conversation can never continue (2026-10-01).
 *
 * Recreating at the SAME path keeps the transcript key intact, so the agent
 * resumes with its full history.
 */

const MANAGED_SEGMENT = `${sep}.aplus${sep}worktrees${sep}`;
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

export type MissingWorktreeRestoreResult =
    | { kind: 'present' }
    | { kind: 'not-managed' }
    | {
        kind: 'recreated';
        worktreePath: string;
        branch: string | null;
        source: 'existing-branch' | 'new-branch' | 'detached';
    }
    | { kind: 'failed'; reason: string };

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    try {
        const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
        return { ok: true, stdout: stdout.trim() };
    } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        const message = typeof stderr === 'string' && stderr.trim()
            ? stderr.trim()
            : error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
    }
}

const exists = (path: string) => access(path).then(() => true, () => false);

async function localBranchExists(root: string, branch: string): Promise<boolean> {
    return (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
}

/** The shallowest missing directory below the managed root is the removed worktree itself. */
async function removedWorktreePath(managedRoot: string, cwd: string): Promise<string | null> {
    let candidate = managedRoot;
    for (const segment of relative(managedRoot, cwd).split(sep)) {
        candidate = join(candidate, segment);
        if (!await exists(candidate)) return candidate;
    }
    return null;
}

export async function restoreMissingManagedWorktree(input: {
    cwd: string;
    /** The branch the agent last worked on, from its own transcript. */
    branchHint: string | null;
}): Promise<MissingWorktreeRestoreResult> {
    const cwd = resolve(input.cwd);
    if (await exists(cwd)) return { kind: 'present' };

    const marker = cwd.indexOf(MANAGED_SEGMENT);
    if (marker <= 0) return { kind: 'not-managed' };
    const root = cwd.slice(0, marker);
    const managedRoot = join(root, '.aplus', 'worktrees');
    if (!await exists(root)) return { kind: 'failed', reason: 'repository root is missing' };

    const toplevel = await git(root, ['rev-parse', '--show-toplevel']);
    if (!toplevel.ok) return { kind: 'failed', reason: `repository lookup failed: ${toplevel.error}` };
    if (await realpath(toplevel.stdout).catch(() => null) !== await realpath(root).catch(() => null)) {
        return { kind: 'failed', reason: 'managed worktree root is not a repository checkout' };
    }

    const worktreePath = await removedWorktreePath(managedRoot, cwd);
    if (!worktreePath) return { kind: 'failed', reason: 'could not locate the removed worktree' };

    // A worktree deleted without `git worktree remove` stays registered and
    // blocks `add`. Pruning only drops entries whose directory is gone.
    await git(root, ['worktree', 'prune']);

    const hint = input.branchHint?.trim() || null;
    const existing = [hint, basename(worktreePath)]
        .filter((branch): branch is string => Boolean(branch));
    let added: Awaited<ReturnType<typeof git>> | null = null;
    let result: Extract<MissingWorktreeRestoreResult, { kind: 'recreated' }> | null = null;
    for (const branch of existing) {
        if (!await localBranchExists(root, branch)) continue;
        added = await git(root, ['worktree', 'add', worktreePath, branch]);
        result = { kind: 'recreated', worktreePath, branch, source: 'existing-branch' };
        break;
    }
    if (!added && hint && (await git(root, ['check-ref-format', '--branch', hint])).ok) {
        added = await git(root, ['worktree', 'add', '-b', hint, worktreePath, 'HEAD']);
        result = { kind: 'recreated', worktreePath, branch: hint, source: 'new-branch' };
    }
    if (!added) {
        added = await git(root, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
        result = { kind: 'recreated', worktreePath, branch: null, source: 'detached' };
    }
    if (!added.ok || !result) return { kind: 'failed', reason: `worktree add failed: ${added.ok ? 'unknown' : added.error}` };

    if (!await exists(cwd)) {
        await git(root, ['worktree', 'remove', '--force', worktreePath]);
        return { kind: 'failed', reason: 'session directory is not part of the recreated worktree' };
    }
    return result;
}

/** The last `gitBranch` a Claude transcript recorded, or null. Reads only the tail. */
export async function readClaudeTranscriptBranch(transcriptPath: string): Promise<string | null> {
    let handle;
    try {
        handle = await open(transcriptPath, 'r');
        const { size } = await handle.stat();
        const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const matches = [...buffer.toString('utf8').matchAll(/"gitBranch":"((?:[^"\\]|\\.)*)"/g)];
        const branch = matches.at(-1)?.[1];
        return branch && branch !== 'HEAD' ? branch : null;
    } catch {
        return null;
    } finally {
        await handle?.close();
    }
}
