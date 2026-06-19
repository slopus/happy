import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree } from './createWorktree';

describe('createWorktree', () => {
    const created: string[] = [];

    afterEach(() => {
        for (const dir of created) {
            try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        created.length = 0;
    });

    function makeRepo(): string {
        const dir = mkdtempSync(join(tmpdir(), 'happy-wt-test-'));
        created.push(dir);
        execFileSync('git', ['-C', dir, 'init', '-q']);
        execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@happy.dev']);
        execFileSync('git', ['-C', dir, 'config', 'user.name', 'happy-test']);
        // worktree add -b requires at least one commit (no unborn HEAD)
        execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-q', '-m', 'init']);
        return dir;
    }

    it('creates a worktree under .dev/worktree with a matching branch', async () => {
        const repo = makeRepo();
        const result = await createWorktree(repo);

        expect(result.worktreePath).toContain('/.dev/worktree/');
        expect(result.worktreePath.endsWith(result.branchName)).toBe(true);
        expect(existsSync(result.worktreePath)).toBe(true);

        const branches = execFileSync('git', ['-C', repo, 'branch', '--list', result.branchName]).toString();
        expect(branches).toContain(result.branchName);

        const worktrees = execFileSync('git', ['-C', repo, 'worktree', 'list']).toString();
        expect(worktrees).toContain(result.worktreePath);
    });

    it('creates distinct worktrees on repeated calls', async () => {
        const repo = makeRepo();
        const a = await createWorktree(repo);
        const b = await createWorktree(repo);
        expect(a.worktreePath).not.toBe(b.worktreePath);
        expect(a.branchName).not.toBe(b.branchName);
    });

    it('throws for a non-git directory', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-nongit-'));
        created.push(dir);
        await expect(createWorktree(dir)).rejects.toThrow();
    });
});
