import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeTranscriptBranch, restoreMissingManagedWorktree } from './missingWorktreeRestore';

const exec = promisify(execFile);
const garbage: string[] = [];
const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
async function git(cwd: string, ...args: string[]) {
    return (await exec('git', ['-C', cwd, ...args], { env: gitEnv })).stdout.trim();
}
const exists = (path: string) => access(path).then(() => true, () => false);

async function fixture() {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'worktree-restore-')));
    garbage.push(base);
    const root = join(base, 'repo');
    await mkdir(join(root, 'packages/web'), { recursive: true });
    await writeFile(join(root, '.gitignore'), '.aplus/\n');
    await writeFile(join(root, 'packages/web/index.ts'), 'export {}\n');
    await git(root, 'init', '-b', 'main');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'fixture');
    return { root };
}

afterEach(async () => {
    await Promise.all(garbage.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('restoreMissingManagedWorktree', () => {
    it('recreates a removed worktree on its preserved branch at the same path', async () => {
        const { root } = await fixture();
        const worktree = join(root, '.aplus/worktrees/project-a/eager-lynx');
        await git(root, 'worktree', 'add', '-b', 'feature/kept', worktree);
        await writeFile(join(worktree, 'work.txt'), 'kept work\n');
        await git(worktree, 'add', 'work.txt');
        await git(worktree, 'commit', '-m', 'work');
        await git(root, 'worktree', 'remove', worktree);

        const result = await restoreMissingManagedWorktree({ cwd: worktree, readBranchHint: async () => 'feature/kept' });

        expect(result).toEqual({ kind: 'recreated', worktreePath: worktree, branch: 'feature/kept', source: 'existing-branch' });
        expect(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/kept');
        expect(await exists(join(worktree, 'work.txt'))).toBe(true);
    });

    it('recreates the deleted branch from the main checkout HEAD when the branch is gone', async () => {
        const { root } = await fixture();
        const worktree = join(root, '.aplus/worktrees/eager-lynx');
        await git(root, 'worktree', 'add', '-b', 'eager-lynx', worktree);
        await git(root, 'worktree', 'remove', worktree);
        await git(root, 'branch', '-D', 'eager-lynx');

        const result = await restoreMissingManagedWorktree({ cwd: worktree, readBranchHint: async () => 'eager-lynx' });

        expect(result).toEqual({ kind: 'recreated', worktreePath: worktree, branch: 'eager-lynx', source: 'new-branch' });
        expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(await git(root, 'rev-parse', 'HEAD'));
    });

    it('falls back to the branch named after the worktree when the transcript gives no branch', async () => {
        const { root } = await fixture();
        const worktree = join(root, '.aplus/worktrees/project-a/proud-tiger');
        await git(root, 'worktree', 'add', '-b', 'proud-tiger', worktree);
        await git(root, 'worktree', 'remove', worktree);

        const result = await restoreMissingManagedWorktree({ cwd: worktree, readBranchHint: async () => null });

        expect(result).toMatchObject({ kind: 'recreated', branch: 'proud-tiger', source: 'existing-branch' });
    });

    it('restores a session whose cwd was a subdirectory of the removed worktree', async () => {
        const { root } = await fixture();
        const worktree = join(root, '.aplus/worktrees/project-a/sub');
        await git(root, 'worktree', 'add', '-b', 'sub', worktree);
        await git(root, 'worktree', 'remove', worktree);
        const cwd = join(worktree, 'packages/web');

        const result = await restoreMissingManagedWorktree({ cwd, readBranchHint: async () => 'sub' });

        expect(result).toMatchObject({ kind: 'recreated', worktreePath: worktree });
        expect(await exists(cwd)).toBe(true);
    });

    it('leaves directories outside the managed worktree root alone', async () => {
        const { root } = await fixture();
        const cwd = join(root, 'deleted-elsewhere');

        expect(await restoreMissingManagedWorktree({ cwd, readBranchHint: async () => 'main' })).toEqual({ kind: 'not-managed' });
        expect(await exists(cwd)).toBe(false);
    });

    it('does nothing, and reads no transcript, when the directory still exists', async () => {
        const { root } = await fixture();
        let read = false;
        const readBranchHint = async () => { read = true; return null; };

        expect(await restoreMissingManagedWorktree({ cwd: root, readBranchHint })).toEqual({ kind: 'present' });
        expect(read).toBe(false);
    });

    it('recreates a pushed branch from origin when only the local branch was deleted', async () => {
        const { root } = await fixture();
        const remote = join(root, '..', 'remote.git');
        await exec('git', ['init', '--bare', '-b', 'main', remote], { env: gitEnv });
        await git(root, 'remote', 'add', 'origin', remote);
        const worktree = join(root, '.aplus/worktrees/pushed');
        await git(root, 'worktree', 'add', '-b', 'pushed', worktree);
        await writeFile(join(worktree, 'pushed.txt'), 'pushed work\n');
        await git(worktree, 'add', 'pushed.txt');
        await git(worktree, 'commit', '-m', 'pushed');
        await git(worktree, 'push', 'origin', 'pushed');
        await git(root, 'worktree', 'remove', worktree);
        await git(root, 'branch', '-D', 'pushed');

        const result = await restoreMissingManagedWorktree({ cwd: worktree, readBranchHint: async () => 'pushed' });

        expect(result).toEqual({ kind: 'recreated', worktreePath: worktree, branch: 'pushed', source: 'remote-branch' });
        expect(await exists(join(worktree, 'pushed.txt'))).toBe(true);
    });

    it('never passes a transcript branch that git would read as an option', async () => {
        const { root } = await fixture();
        const worktree = join(root, '.aplus/worktrees/option-like');
        await git(root, 'worktree', 'add', '--detach', worktree);
        await git(root, 'worktree', 'remove', worktree);

        const result = await restoreMissingManagedWorktree({ cwd: worktree, readBranchHint: async () => '--orphan' });

        expect(result).toEqual({ kind: 'recreated', worktreePath: worktree, branch: null, source: 'detached' });
    });

    it('rolls back the worktree and the branch it created when the session directory is still missing', async () => {
        const { root } = await fixture();
        const worktree = join(root, '.aplus/worktrees/rollback');
        const cwd = join(worktree, 'not-in-repo');

        const result = await restoreMissingManagedWorktree({ cwd, readBranchHint: async () => 'rollback-branch' });

        expect(result.kind).toBe('failed');
        expect(await exists(worktree)).toBe(false);
        expect(await git(root, 'branch', '--list', 'rollback-branch')).toBe('');
    });

    it('fails instead of stealing a preserved branch checked out elsewhere', async () => {
        const { root } = await fixture();
        const worktree = join(root, '.aplus/worktrees/taken');
        await git(root, 'worktree', 'add', '-b', 'taken', worktree);
        await git(root, 'worktree', 'remove', worktree);
        await git(root, 'worktree', 'add', join(root, '.aplus/worktrees/other'), 'taken');

        const result = await restoreMissingManagedWorktree({ cwd: worktree, readBranchHint: async () => 'taken' });

        expect(result.kind).toBe('failed');
        expect(await exists(worktree)).toBe(false);
    });
});

describe('readClaudeTranscriptBranch', () => {
    it('returns the branch recorded by the latest transcript entry', async () => {
        const dir = await realpath(await mkdtemp(join(tmpdir(), 'transcript-branch-')));
        garbage.push(dir);
        const file = join(dir, 'session.jsonl');
        await writeFile(file, [
            JSON.stringify({ type: 'user', gitBranch: 'first-name' }),
            JSON.stringify({ type: 'assistant', gitBranch: 'renamed-branch' }),
            JSON.stringify({ type: 'summary' }),
        ].join('\n'));

        expect(await readClaudeTranscriptBranch(file)).toBe('renamed-branch');
    });

    it('decodes JSON escapes in the recorded branch', async () => {
        const dir = await realpath(await mkdtemp(join(tmpdir(), 'transcript-branch-')));
        garbage.push(dir);
        const file = join(dir, 'session.jsonl');
        await writeFile(file, '{"gitBranch":"feat\\/\\u00e9t\\u00e9"}\n');

        expect(await readClaudeTranscriptBranch(file)).toBe('feat/été');
    });

    it('ignores detached HEAD and missing transcripts', async () => {
        const dir = await realpath(await mkdtemp(join(tmpdir(), 'transcript-branch-')));
        garbage.push(dir);
        const file = join(dir, 'session.jsonl');
        await writeFile(file, JSON.stringify({ gitBranch: 'HEAD' }));

        expect(await readClaudeTranscriptBranch(file)).toBeNull();
        expect(await readClaudeTranscriptBranch(join(dir, 'missing.jsonl'))).toBeNull();
    });
});
