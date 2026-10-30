import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The git status readers run in the agent's working tree while the agent is
// working, so they must never take .git/index.lock: a read that rewrites the
// index makes the agent's own `git commit` or `git rebase` fail with
// "Unable to create '.git/index.lock': File exists". These tests run the real
// commands in a real repository whose files are stat-dirty (touched, content
// unchanged), which is the state where `git status` and `git diff` rewrite it.

const mocks = vi.hoisted(() => ({ repo: '', applyGitStatus: vi.fn() }));

vi.mock('./ops', () => ({
    sessionBash: async (_sessionId: string, request: { command: string; cwd?: string }) => {
        try {
            const stdout = execSync(request.command, { cwd: request.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            return { success: true, stdout, stderr: '', exitCode: 0 };
        } catch (error) {
            const failure = error as { status?: number; stdout?: string; stderr?: string };
            return { success: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.status ?? 1 };
        }
    },
}));

vi.mock('./storage', () => ({
    storage: {
        getState: () => ({
            sessions: { session: { metadata: { machineId: 'machine', path: mocks.repo } } },
            applyGitStatus: mocks.applyGitStatus,
        }),
    },
}));

import { getGitStatusFiles } from './gitStatusFiles';
import { gitStatusSync } from './gitStatusSync';

function git(args: string) {
    execSync(`git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false ${args}`, { cwd: mocks.repo, stdio: 'ignore' });
}

// git rewrites the index by renaming index.lock over it, so the inode changes.
function indexIdentity(): string {
    const stat = statSync(join(mocks.repo, '.git', 'index'));
    return `${stat.ino}:${stat.mtimeMs}`;
}

beforeEach(() => {
    mocks.repo = mkdtempSync(join(tmpdir(), 'happy-git-index-lock-'));
    git('init -q');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
        writeFileSync(join(mocks.repo, name), `${name}\n`);
    }
    git('add a.txt b.txt c.txt');
    git('commit -q --no-verify -m init');
    writeFileSync(join(mocks.repo, 'b.txt'), 'b.txt\nmore\n');
    const later = new Date(Date.now() + 10_000);
    for (const name of ['a.txt', 'c.txt']) {
        utimesSync(join(mocks.repo, name), later, later);
    }
});

afterEach(() => {
    rmSync(mocks.repo, { recursive: true, force: true });
    mocks.applyGitStatus.mockReset();
});

describe('git status readers leave the index alone', () => {
    it('getGitStatusFiles reports the real change without rewriting the index', async () => {
        const before = indexIdentity();
        const result = await getGitStatusFiles('session');
        expect(indexIdentity()).toBe(before);
        expect(result?.unstagedFiles.map((file) => [file.fileName, file.linesAdded, file.linesRemoved])).toEqual([['b.txt', 1, 0]]);
        expect(result?.stagedFiles).toEqual([]);
    });

    it('the status poll reports the real change without rewriting the index', async () => {
        const before = indexIdentity();
        await gitStatusSync.getSync('session').invalidateAndAwait();
        expect(indexIdentity()).toBe(before);
        expect(mocks.applyGitStatus).toHaveBeenCalledWith(
            `machine:${mocks.repo}`,
            expect.objectContaining({ modifiedCount: 1, unstagedLinesAdded: 1, unstagedLinesRemoved: 0 }),
        );
        gitStatusSync.stop('session');
    });
});
