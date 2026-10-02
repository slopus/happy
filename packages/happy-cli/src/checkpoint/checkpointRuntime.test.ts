import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedLinuxSandboxDependencyStatus } from '@/sandbox/dependencyPreflight';
import { createCheckpointRuntime } from './checkpointRuntime';

vi.mock('@/sandbox/dependencyPreflight', () => ({
    cachedLinuxSandboxDependencyStatus: vi.fn(() => ({ ok: true })),
}));
import { CheckpointStore, checkpointOperationRefPrefix, resolveCheckpointStoreLayout } from './checkpointStore';
import { checkpointCoverageMatcher } from './checkpointCoverage';

const execFileAsync = promisify(execFile);

describe('createCheckpointRuntime', () => {
    it('stores large immutable coverage without putting it in a process argument', async () => {
        const excludedPaths = Array.from({ length: 5_000 }, (_, index) => `ignored/${index}-${'long-name-'.repeat(10)}`);
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding, projectPath, operationId: 'large-coverage', excludedPaths,
        });
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout } = await execFileAsync('git', [`--git-dir=${layout.gitDirectory}`,
            'show', '-s', '--format=%B', snapshot.checkpointId], { maxBuffer: 2 * 1024 * 1024 });
        const matcher = checkpointCoverageMatcher(stdout);
        expect(matcher?.(excludedPaths[4_999])).toBe(true);
        expect(matcher?.('source.txt')).toBe(false);
    });
    let fixtureRoot: string;
    let projectPath: string;
    let checkpointRoot: string;
    const protection = {
        secretPatterns: ['.env*'],
        maxFileBytes: 8,
        maxFiles: 100,
        maxTotalBytes: 4096,
    };
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    };

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-runtime-'));
        projectPath = join(fixtureRoot, 'project');
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        await mkdir(projectPath);
        await writeFile(join(projectPath, 'source.txt'), 'before');
        await writeFile(join(projectPath, '.env.local'), 'SECRET=value');
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('stays disabled without an explicit checkpoint protection block', async () => {
        expect(await createCheckpointRuntime({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            checkpointRoot,
            binding,
            protection: undefined,
        })).toEqual({ status: 'disabled' });
    });

    it('reports unsupported platforms without creating a protected runtime', async () => {
        expect(await createCheckpointRuntime({
            provider: 'codex',
            platform: 'win32',
            projectPath,
            checkpointRoot,
            binding,
            protection,
        })).toEqual({ status: 'unavailable', reason: 'unsupported-platform' });
    });

    // specs/linux-checkpoint-enforcement-backend R1/R2
    it('opens a protected runtime on Linux only when the bubblewrap dependencies are present', async () => {
        vi.mocked(cachedLinuxSandboxDependencyStatus).mockReturnValueOnce({ ok: false, missing: ['bwrap'] });
        expect(await createCheckpointRuntime({
            provider: 'codex',
            platform: 'linux',
            projectPath,
            checkpointRoot,
            binding,
            protection,
        })).toEqual({ status: 'unavailable', reason: 'unsupported-platform' });

        vi.mocked(cachedLinuxSandboxDependencyStatus).mockReturnValueOnce({ ok: true });
        expect(await createCheckpointRuntime({
            provider: 'claude-remote',
            platform: 'linux',
            projectPath,
            checkpointRoot,
            binding,
            protection,
        })).toMatchObject({ status: 'protected' });
    });

    it('fixes sandbox deny before the first snapshot and excludes secret content from Git', async () => {
        const result = await createCheckpointRuntime({
            provider: 'claude-remote',
            platform: 'darwin',
            projectPath,
            checkpointRoot,
            binding,
            protection,
        });
        expect(result.status).toBe('protected');
        if (result.status !== 'protected') throw new Error('expected protected runtime');
        expect(result.denyWritePaths).toContain(join(await realpath(projectPath), '**', '.env*'));

        const first = await result.beforeTurn('turn-1');
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: files } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'ls-tree',
            '-r',
            '--name-only',
            first.checkpointId,
        ]);
        expect(files.split('\n')).toContain('source.txt');
        expect(files.split('\n')).not.toContain('.env.local');
    });

    it('refreshes a later turn when unrelated secret exclusions change', async () => {
        const result = await createCheckpointRuntime({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            checkpointRoot,
            binding,
            protection,
        });
        if (result.status !== 'protected') throw new Error('expected protected runtime');
        await result.beforeTurn('turn-1');
        await writeFile(join(projectPath, '.env.production'), 'new secret');

        await expect(result.beforeTurn('turn-2')).resolves.toMatchObject({ checkpointId: expect.any(String) });
        expect(result.excludedPaths).toContain('.env.production');
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: count } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        expect(count.trim().split('\n').filter(Boolean)).toHaveLength(2);
    });

    it.each(['repository', 'gitfile', 'fifo'] as const)('excludes unsupported %s entries without permanent drift', async (kind) => {
        if (kind === 'fifo') await execFileAsync('mkfifo', [join(projectPath, 'named-pipe')]);
        else {
            const nested = join(projectPath, 'nested');
            await mkdir(nested);
            if (kind === 'repository') await execFileAsync('git', ['init', nested]);
            else await writeFile(join(nested, '.git'), 'gitdir: /not-followed\n');
            await writeFile(join(nested, 'source.ts'), 'nested content');
        }
        const runtime = await createCheckpointRuntime({ provider: 'codex', platform: 'darwin', projectPath,
            checkpointRoot, binding, protection });
        if (runtime.status !== 'protected') throw new Error('expected protected runtime');
        await expect(runtime.beforeTurn('unsupported-entries')).resolves.toMatchObject({ checkpointId: expect.any(String) });
        expect(runtime.excludedPaths).toContain(kind === 'fifo' ? 'named-pipe' : 'nested');
    });

    it('records excluded file names containing control characters in the coverage trailer', async () => {
        await writeFile(join(projectPath, '.gitignore'), 'Icon?\n');
        await writeFile(join(projectPath, 'Icon\r'), '');
        await writeFile(join(projectPath, 'big\tdata.bin'), 'more than eight bytes');
        const runtime = await createCheckpointRuntime({ provider: 'codex', platform: 'darwin', projectPath,
            checkpointRoot, binding, protection });
        if (runtime.status !== 'protected') throw new Error('expected protected runtime');
        const snapshot = await runtime.beforeTurn('control-character-paths');
        expect(runtime.excludedPaths).toEqual(expect.arrayContaining(['Icon\r', 'big\tdata.bin']));
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout } = await execFileAsync('git', [`--git-dir=${layout.gitDirectory}`,
            'show', '-s', '--format=%B', snapshot.checkpointId]);
        const matcher = checkpointCoverageMatcher(stdout);
        expect(matcher?.('Icon\r')).toBe(true);
        expect(matcher?.('big\tdata.bin')).toBe(true);
        expect(matcher?.('source.txt')).toBe(false);
    });
});
