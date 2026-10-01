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
        source: 'existing-branch' | 'remote-branch' | 'new-branch' | 'detached';
    }
    | { kind: 'failed'; reason: string };

type Recreated = Extract<MissingWorktreeRestoreResult, { kind: 'recreated' }>;

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

async function refExists(root: string, ref: string): Promise<boolean> {
    return (await git(root, ['rev-parse', '--verify', '--quiet', ref])).ok;
}

/** Rejects anything git would not accept as a branch name — including `-`-prefixed option look-alikes. */
async function isBranchName(root: string, name: string): Promise<boolean> {
    return !name.startsWith('-') && (await git(root, ['check-ref-format', '--branch', name])).ok;
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
    /** The branch the agent last worked on, from its own transcript. Only read when the directory is missing. */
    readBranchHint: () => Promise<string | null>;
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

    const rawHint = (await input.readBranchHint().catch(() => null))?.trim() || null;
    const hint = rawHint && await isBranchName(root, rawHint) ? rawHint : null;
    const folderBranch = basename(worktreePath);
    const plan = await chooseCheckout(root, worktreePath, hint,
        await isBranchName(root, folderBranch) ? folderBranch : null);

    const added = await git(root, ['worktree', 'add', ...plan.args]);
    if (!added.ok) return { kind: 'failed', reason: `worktree add failed: ${added.error}` };

    if (!await exists(cwd)) {
        await git(root, ['worktree', 'remove', '--force', '--', worktreePath]);
        if (plan.result.source !== 'existing-branch' && plan.result.branch) {
            await git(root, ['branch', '-D', '--', plan.result.branch]);
        }
        return { kind: 'failed', reason: 'session directory is not part of the recreated worktree' };
    }
    return plan.result;
}

async function chooseCheckout(
    root: string,
    worktreePath: string,
    hint: string | null,
    folderBranch: string | null,
): Promise<{ args: string[]; result: Recreated }> {
    const recreated = (branch: string | null, source: Recreated['source']): Recreated =>
        ({ kind: 'recreated', worktreePath, branch, source });
    for (const branch of [hint, folderBranch]) {
        if (branch && await refExists(root, `refs/heads/${branch}`)) {
            return { args: ['--', worktreePath, branch], result: recreated(branch, 'existing-branch') };
        }
    }
    if (hint) {
        // Desktop's sweep keeps branches so pushed work can come back; a local
        // branch deleted after push still has its commits on origin.
        const remote = `refs/remotes/origin/${hint}`;
        if (await refExists(root, remote)) {
            return { args: ['-b', hint, '--', worktreePath, remote], result: recreated(hint, 'remote-branch') };
        }
        return { args: ['-b', hint, '--', worktreePath, 'HEAD'], result: recreated(hint, 'new-branch') };
    }
    return { args: ['--detach', '--', worktreePath, 'HEAD'], result: recreated(null, 'detached') };
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
        const matches = [...buffer.toString('utf8').matchAll(/"gitBranch":("(?:[^"\\]|\\.)*")/g)];
        const encoded = matches.at(-1)?.[1];
        const branch = encoded ? JSON.parse(encoded) as string : null;
        return branch && branch !== 'HEAD' ? branch : null;
    } catch {
        return null;
    } finally {
        await handle?.close();
    }
}
