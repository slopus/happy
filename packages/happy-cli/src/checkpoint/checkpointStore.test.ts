import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkpointCoverageMatcher } from './checkpointCoverage';
import { withCheckpointStoreLock } from './checkpointStoreLock';
import {
    checkpointOperationRefPrefix,
    CheckpointStore,
    resolveCheckpointStoreLayout,
    validateCheckpointProjectPath,
} from './checkpointStore';

const execFileAsync = promisify(execFile);

describe('resolveCheckpointStoreLayout', () => {
    const checkpointRoot = join(tmpdir(), 'happy-checkpoint-layout');

    it('shares objects while isolating project and worktree state', () => {
        const main = resolveCheckpointStoreLayout({
            checkpointRoot,
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
        });
        const worktree = resolveCheckpointStoreLayout({
            checkpointRoot,
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
        });
        const otherProject = resolveCheckpointStoreLayout({
            checkpointRoot,
            sessionId: 'session-1',
            projectId: 'project-2',
            worktreeId: null,
        });
        const otherSession = resolveCheckpointStoreLayout({
            checkpointRoot,
            sessionId: 'session-2',
            projectId: 'project-1',
            worktreeId: null,
        });

        expect(new Set([
            main.gitDirectory,
            worktree.gitDirectory,
            otherProject.gitDirectory,
            otherSession.gitDirectory,
        ])).toHaveLength(1);
        expect(new Set([
            main.refName,
            worktree.refName,
            otherProject.refName,
            otherSession.refName,
        ])).toHaveLength(4);
        expect(new Set([
            main.indexFile,
            worktree.indexFile,
            otherProject.indexFile,
            otherSession.indexFile,
        ])).toHaveLength(4);
        expect(new Set([
            main.metadataFile,
            worktree.metadataFile,
            otherProject.metadataFile,
            otherSession.metadataFile,
        ])).toHaveLength(4);
        expect(new Set([
            main.ledgerFile,
            worktree.ledgerFile,
            otherProject.ledgerFile,
            otherSession.ledgerFile,
        ])).toHaveLength(4);
    });

    it('keeps opaque binding identifiers inside the machine-local root', () => {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot,
            sessionId: '../session',
            projectId: '../../project',
            worktreeId: '../worktree',
        });

        for (const path of [layout.gitDirectory, layout.indexFile, layout.metadataFile]) {
            expect(relative(checkpointRoot, path)).not.toMatch(/^\.\.(?:[/\\]|$)/);
        }
        expect(layout.refName).toMatch(/^refs\/saycode-checkpoints\/[a-f0-9]+$/);
        expect(JSON.stringify(layout)).not.toContain('../');
    });

    it('rejects broad projects and a shadow store inside the project', () => {
        expect(() => validateCheckpointProjectPath({
            projectPath: parse(checkpointRoot).root,
            checkpointRoot,
            userHomePath: homedir(),
        })).toThrow('checkpoint project path is too broad');
        expect(() => validateCheckpointProjectPath({
            projectPath: homedir(),
            checkpointRoot,
            userHomePath: homedir(),
        })).toThrow('checkpoint project path is too broad');
        expect(() => validateCheckpointProjectPath({
            projectPath: checkpointRoot,
            checkpointRoot: join(checkpointRoot, '.checkpoints'),
            userHomePath: homedir(),
        })).toThrow('checkpoint store overlaps project path');
    });
});

describe('CheckpointStore', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-store-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        await mkdir(projectPath);
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('creates at most one snapshot per operation and captures the next turn separately', async () => {
        const store = new CheckpointStore(checkpointRoot);
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        };
        await writeFile(join(projectPath, 'message.txt'), 'before\n');

        const first = await store.snapshotTurn({ ...binding, operationId: 'turn-1' });
        await writeFile(join(projectPath, 'message.txt'), 'after\n');
        const duplicate = await store.snapshotTurn({ ...binding, operationId: 'turn-1' });
        const second = await store.snapshotTurn({ ...binding, operationId: 'turn-2' });

        expect(duplicate.checkpointId).toBe(first.checkpointId);
        expect(second.checkpointId).not.toBe(first.checkpointId);

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: count } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        const [{ stdout: before }, { stdout: after }] = await Promise.all([
            execFileAsync('git', [
                `--git-dir=${layout.gitDirectory}`,
                'show',
                `${first.checkpointId}:message.txt`,
            ]),
            execFileAsync('git', [
                `--git-dir=${layout.gitDirectory}`,
                'show',
                `${second.checkpointId}:message.txt`,
            ]),
        ]);

        expect(count.trim().split('\n').filter(Boolean)).toHaveLength(2);
        expect(before).toBe('before\n');
        expect(after).toBe('after\n');
    });

    it('reuses the durable operation checkpoint after a daemon restart', async () => {
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        };
        await writeFile(join(projectPath, 'message.txt'), 'before\n');
        const first = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-retried-after-restart',
        });
        await writeFile(join(projectPath, 'message.txt'), 'changed after checkpoint\n');

        const retried = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-retried-after-restart',
        });

        expect(retried).toEqual({ checkpointId: first.checkpointId, created: false });
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: count } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        expect(count.trim().split('\n').filter(Boolean)).toHaveLength(1);
    });

    it('converges concurrent daemon instances on one durable operation checkpoint', async () => {
        const request = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
            operationId: 'turn-overlapping-daemons',
        } as const;
        await writeFile(join(projectPath, 'message.txt'), 'before\n');
        await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...request,
            operationId: 'turn-bootstrap-store',
        });
        await writeFile(join(projectPath, 'message.txt'), 'overlapping daemon version\n');

        const results = await Promise.all([
            new CheckpointStore(checkpointRoot).snapshotTurn(request),
            new CheckpointStore(checkpointRoot).snapshotTurn(request),
        ]);

        expect(new Set(results.map(({ checkpointId }) => checkpointId))).toHaveLength(1);
        expect(results.filter(({ created }) => created)).toHaveLength(1);
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...request });
        const { stdout } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(2);
    });

    it('rejects rebinding the same identity to another project path', async () => {
        const otherProjectPath = join(fixtureRoot, 'other-project');
        await mkdir(otherProjectPath);
        await writeFile(join(projectPath, 'message.txt'), 'first project\n');
        await writeFile(join(otherProjectPath, 'message.txt'), 'other project\n');
        await new CheckpointStore(checkpointRoot).snapshotTurn({
            sessionId: 'bootstrap-session',
            projectId: 'bootstrap-project',
            worktreeId: null,
            operationId: 'turn-bootstrap-binding-race',
            projectPath,
        });
        const store = new CheckpointStore(checkpointRoot);
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
        };

        await store.snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });

        await expect(store.snapshotTurn({
            ...binding,
            operationId: 'turn-2',
            projectPath: otherProjectPath,
        })).rejects.toThrow('checkpoint binding path mismatch');

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: count } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        expect(count.trim().split('\n').filter(Boolean)).toHaveLength(1);
    });

    it('atomically binds one project when different paths race on first snapshot', async () => {
        const otherProjectPath = join(fixtureRoot, 'other-project');
        await mkdir(otherProjectPath);
        await writeFile(join(projectPath, 'message.txt'), 'first project\n');
        await writeFile(join(otherProjectPath, 'message.txt'), 'other project\n');
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
        } as const;
        const results = await Promise.allSettled([
            new CheckpointStore(checkpointRoot).snapshotTurn({
                ...binding,
                operationId: 'turn-first-project',
                projectPath,
            }),
            new CheckpointStore(checkpointRoot).snapshotTurn({
                ...binding,
                operationId: 'turn-other-project',
                projectPath: otherProjectPath,
            }),
        ]);

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        const winningIndex = results.findIndex(({ status }) => status === 'fulfilled');
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const metadata = JSON.parse(await readFile(layout.metadataFile, 'utf8')) as { projectPath: string };
        expect(metadata.projectPath).toBe(await realpath(
            winningIndex === 0 ? projectPath : otherProjectPath,
        ));
    });

    it('excludes secret globs even when an exact manifest path was not supplied', async () => {
        await writeFile(join(projectPath, 'source.txt'), 'safe\n');
        await writeFile(join(projectPath, '.env.raced'), 'SECRET=value\n');
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        };

        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            excludedPatterns: ['**/.env*'],
        });
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'ls-tree',
            '-r',
            '--name-only',
            snapshot.checkpointId,
        ]);

        expect(stdout.split('\n')).toContain('source.txt');
        expect(stdout.split('\n')).not.toContain('.env.raced');
    });

    // specs/checkpoint-local-history R2 — record the whole folder the agent works in, not a bounded
    // manifest: a project over the old 100-file limit, its symlinks and its nested repositories.
    describe('local-history work tree', () => {
        const binding = () => ({ sessionId: 'session-1', projectId: 'project-1', worktreeId: null, projectPath });
        const git = (args: string[]) => execFileAsync('git', [`--git-dir=${resolveCheckpointStoreLayout({ checkpointRoot, ...binding() }).gitDirectory}`, ...args]);
        const recorded = async (checkpointId: string) => (await git(['ls-tree', '-r', '--name-only', checkpointId])).stdout.split('\n').filter(Boolean);

        it('records every file of a project far over the old file limit, with symlinks', async () => {
            for (let index = 0; index < 150; index += 1) await writeFile(join(projectPath, `file-${index}.txt`), `${index}\n`);
            await symlink('file-0.txt', join(projectPath, 'link.txt'));

            const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
                ...binding(), operationId: 'turn-1', workTree: { maxFileBytes: 1024 },
            });

            const paths = await recorded(snapshot.checkpointId);
            expect(paths).toHaveLength(151);
            expect((await git(['ls-tree', snapshot.checkpointId, 'link.txt'])).stdout).toMatch(/^120000 blob /);
        });

        it('leaves files over the size cap and nested repositories unrecorded, and says so in coverage', async () => {
            await writeFile(join(projectPath, 'small.txt'), 'small\n');
            await writeFile(join(projectPath, 'large.bin'), Buffer.alloc(2048));
            await mkdir(join(projectPath, 'nested'));
            await execFileAsync('git', ['init', '--quiet', join(projectPath, 'nested')]);
            await writeFile(join(projectPath, 'nested', 'inner.txt'), 'inner\n');

            const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
                ...binding(), operationId: 'turn-1', workTree: { maxFileBytes: 1024 },
            });

            const paths = await recorded(snapshot.checkpointId);
            expect(paths).toContain('small.txt');
            expect(paths).not.toContain('large.bin');
            expect(paths.filter((path) => path.startsWith('nested'))).toEqual([]);
            const body = (await git(['show', '-s', '--format=%b', snapshot.checkpointId])).stdout;
            expect(body).toContain('saycode-local-history-v1');
            expect(checkpointCoverageMatcher(body)?.('large.bin')).toBe(true);
            expect(checkpointCoverageMatcher(body)?.('nested/inner.txt')).toBe(true);
            expect(checkpointCoverageMatcher(body)?.('small.txt')).toBe(false);
        });

        it('follows the project ignore rules without touching the project repository', async () => {
            await execFileAsync('git', ['init', '--quiet', projectPath]);
            await writeFile(join(projectPath, '.gitignore'), 'dist/\n');
            await mkdir(join(projectPath, 'dist'));
            await writeFile(join(projectPath, 'dist', 'out.js'), 'built\n');
            await writeFile(join(projectPath, 'source.ts'), 'source\n');
            const gitEntries = async () => (await readdir(join(projectPath, '.git'), { recursive: true })).sort();
            const indexMtime = async () => (await stat(join(projectPath, '.git', 'HEAD'))).mtimeMs;
            const before = { entries: await gitEntries(), head: await indexMtime() };

            const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
                ...binding(), operationId: 'turn-1', workTree: { maxFileBytes: 1024 },
            });

            const paths = await recorded(snapshot.checkpointId);
            expect(paths).toEqual(expect.arrayContaining(['.gitignore', 'source.ts']));
            expect(paths).not.toContain('dist/out.js');
            expect(paths.some((path) => path.startsWith('.git/'))).toBe(false);
            expect({ entries: await gitEntries(), head: await indexMtime() }).toEqual(before);
        });

        it('keeps two worktrees of one project apart when they record at the same time', async () => {
            const otherPath = join(fixtureRoot, 'worktree');
            await mkdir(otherPath);
            await writeFile(join(projectPath, 'a.txt'), 'main\n');
            await writeFile(join(otherPath, 'a.txt'), 'worktree\n');
            const main = { ...binding(), worktreeId: null };
            const worktree = { ...binding(), worktreeId: 'worktree-1', projectPath: otherPath };
            const store = new CheckpointStore(checkpointRoot);
            const otherStore = new CheckpointStore(checkpointRoot);

            const [first, second] = await Promise.all([
                store.snapshotTurn({ ...main, operationId: 'turn-1', workTree: { maxFileBytes: 1024 } }),
                otherStore.snapshotTurn({ ...worktree, operationId: 'turn-1', workTree: { maxFileBytes: 1024 } }),
            ]);

            expect((await git(['show', `${first.checkpointId}:a.txt`])).stdout).toBe('main\n');
            expect((await git(['show', `${second.checkpointId}:a.txt`])).stdout).toBe('worktree\n');
            const mainLayout = resolveCheckpointStoreLayout({ checkpointRoot, ...main });
            const worktreeLayout = resolveCheckpointStoreLayout({ checkpointRoot, ...worktree });
            expect(mainLayout.indexFile).not.toBe(worktreeLayout.indexFile);
            expect((await git(['rev-parse', mainLayout.refName])).stdout.trim()).toBe(first.checkpointId);
            expect((await git(['rev-parse', worktreeLayout.refName])).stdout.trim()).toBe(second.checkpointId);
        });

        it('initializes one shared store when many sessions record for the first time at once', async () => {
            await writeFile(join(projectPath, 'a.txt'), 'one\n');
            for (let round = 0; round < 3; round += 1) {
                const root = join(fixtureRoot, `race-${round}`);
                const results = await Promise.all(Array.from({ length: 8 }, (_unused, index) =>
                    new CheckpointStore(root).snapshotTurn({
                        ...binding(), sessionId: `session-${index}`, operationId: 'turn-1', workTree: { maxFileBytes: 1024 },
                    })));
                expect(results.filter((result) => /^[a-f0-9]{40,64}$/.test(result.checkpointId))).toHaveLength(8);
            }
        }, 60_000);

        // A large first record hashes for a long time; it must not hold every other session's turn.
        it('hashes a whole-folder record while another writer holds the store lock', async () => {
            await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding(), operationId: 'init' });
            for (let index = 0; index < 400; index += 1) {
                await writeFile(join(projectPath, `file-${index}.txt`), `content ${index}\n`);
            }
            const last = (await execFileAsync('git', ['hash-object', join(projectPath, 'file-399.txt')])).stdout.trim();
            const staging = join(checkpointRoot, 'store', 'checkpoint-staging');

            const snapshot = new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding(), operationId: 'turn-1', workTree: { maxFileBytes: 1024 } });
            await expect.poll(() => readdir(staging).then((names) => names.length, () => 0), { timeout: 10_000 }).toBeGreaterThan(0);
            await withCheckpointStoreLock(checkpointRoot, async () => {
                await expect.poll(() => git(['cat-file', '-e', last]).then(() => true, () => false), { timeout: 10_000 }).toBe(true);
            });
            expect((await git(['show', `${(await snapshot).checkpointId}:file-399.txt`])).stdout).toBe('content 399\n');
            expect(await readdir(staging)).toEqual([]);
        }, 30_000);

        it('keeps a per-binding index so later turns only rehash what changed', async () => {
            await writeFile(join(projectPath, 'a.txt'), 'one\n');
            const store = new CheckpointStore(checkpointRoot);
            const first = await store.snapshotTurn({ ...binding(), operationId: 'turn-1', workTree: { maxFileBytes: 1024 } });
            const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding() });
            expect((await stat(layout.indexFile)).isFile()).toBe(true);

            const unchanged = await store.snapshotTurn({ ...binding(), operationId: 'turn-2', workTree: { maxFileBytes: 1024 } });
            await writeFile(join(projectPath, 'a.txt'), 'two\n');
            const changed = await store.snapshotTurn({ ...binding(), operationId: 'turn-3', workTree: { maxFileBytes: 1024 } });

            expect(unchanged).toEqual({ checkpointId: first.checkpointId, created: false });
            expect(changed.created).toBe(true);
            expect((await git(['show', `${changed.checkpointId}:a.txt`])).stdout).toBe('two\n');
        });
    });
});
