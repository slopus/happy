import { CheckpointRestoreExecutor } from './checkpointRestore';
import { CheckpointRestorePlanner } from './checkpointRestorePlan';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointRetention, HISTORY_RETENTION, WORKTREE_HISTORY_GRACE_MS } from './checkpointRetention';
import { CheckpointStore, resolveCheckpointStoreLayout } from './checkpointStore';
import { withCheckpointPin } from './checkpointGarbageCollector';
import { withCheckpointStaging } from './checkpointStoreLock';
const git = promisify(execFile);
describe('daemon local history retention', () => {
    let root: string;
    let checkpointRoot: string;
    let projectPath: string;
    const binding = { sessionId: 'session', projectId: 'project', worktreeId: 'worktree' };
    const request = () => ({ schemaVersion: 1, projectId: binding.projectId, worktreePath: projectPath, immediate: false, action: 'retire' });
    const layout = () => resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
    const snapshot = async () => {
        await writeFile(join(projectPath, 'file.txt'), 'version');
        return (await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, projectPath, operationId: 'turn' })).checkpointId;
    };
    beforeEach(async () => {
        root = await realpath(await mkdtemp(join(tmpdir(), 'history-retention-')));
        checkpointRoot = join(root, 'checkpoints');
        projectPath = join(root, 'repo', '.aplus', 'worktrees', 'project', 'worktree');
        await mkdir(projectPath, { recursive: true });
        await git('git', ['init', join(root, 'repo')]);
    });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });
    it('persists seven-day grace across restarts, retaining old records during grace', async () => {
        expect(HISTORY_RETENTION).toMatchObject({ maxCheckpointsPerBinding: 200, maxAgeMs: 30 * 86400_000, maxStoreBytes: 5 * 1024 ** 3, capacityBudgetMs: 60_000 });
        const id = await snapshot();
        await rm(projectPath, { recursive: true });
        const now = Date.now() + 40 * 86400_000;
        await new CheckpointRetention(checkpointRoot).collect(now);
        expect(await readFile(layout().metadataFile, 'utf8')).toContain('session');
        expect((await new CheckpointRetention(checkpointRoot).collect(now + WORKTREE_HISTORY_GRACE_MS - 1)).prunedCheckpoints).toBe(0);
        expect((await new CheckpointRetention(checkpointRoot).collect(now + WORKTREE_HISTORY_GRACE_MS)).prunedCheckpoints).toBe(1);
        await expect(readFile(layout().metadataFile)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(git('git', [`--git-dir=${layout().gitDirectory}`, 'cat-file', '-e', id])).rejects.toThrow();
    });
    it('resets the grace period when a worktree reappears', async () => {
        await snapshot();
        await rm(projectPath, { recursive: true });
        const now = Date.now();
        await new CheckpointRetention(checkpointRoot).collect(now);
        await mkdir(projectPath);
        await new CheckpointRetention(checkpointRoot).collect(now + WORKTREE_HISTORY_GRACE_MS);
        await rm(projectPath, { recursive: true });
        await new CheckpointRetention(checkpointRoot).collect(now + WORKTREE_HISTORY_GRACE_MS);
        expect((await new CheckpointRetention(checkpointRoot).collect(now + 2 * WORKTREE_HISTORY_GRACE_MS - 1)).prunedCheckpoints).toBe(0);
        expect((await new CheckpointRetention(checkpointRoot).collect(now + 2 * WORKTREE_HISTORY_GRACE_MS)).prunedCheckpoints).toBe(1);
    });
    it('fails closed when a missing worktree has no trustworthy repository anchor', async () => {
        await snapshot();
        await rm(projectPath, { recursive: true });
        await rm(join(root, 'repo', '.git'), { recursive: true });
        expect((await new CheckpointRetention(checkpointRoot).collect(Date.now() + 40 * 86400_000)).prunedCheckpoints).toBe(0);
    });
    it('preserves a legacy safety checkpoint identified by its restore journal', async () => {
        const target = await snapshot();
        await writeFile(join(projectPath, 'file.txt'), 'before restore');
        const plan = await new CheckpointRestorePlanner(checkpointRoot).plan({ ...binding, projectPath, checkpointId: target });
        const restored = await new CheckpointRestoreExecutor(checkpointRoot).execute({ ...binding, projectPath,
            operationId: 'legacy-safety', confirmed: true, plan });
        if (restored.status !== 'completed') throw new Error(restored.status);
        await writeFile(join(projectPath, 'file.txt'), 'new baseline');
        await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, projectPath, operationId: 'later' });
        await new CheckpointRetention(checkpointRoot).collect(Date.now() + 40 * 86400_000);
        await expect(git('git', [`--git-dir=${layout().gitDirectory}`, 'cat-file', '-e', restored.safetyCheckpointId])).resolves.toBeDefined();
    });

    it('rejects foreign metadata/path and refuses retirement while the worktree exists', async () => {
        await snapshot();
        const retention = new CheckpointRetention(checkpointRoot);
        await expect(retention.retireWorktree(request())).rejects.toThrow('still exists');
        await expect(retention.retireWorktree({ ...request(), action: 'inspect', projectId: 'foreign' })).rejects.toThrow('binding');
        await expect(retention.retireWorktree({ ...request(), worktreePath: root })).rejects.toThrow('managed');
        await expect(retention.retireWorktree({ ...request(), immediate: true, confirmed: false })).rejects.toThrow();
    });
    it('deletes only matching history and defers pins or staging', async () => {
        const id = await snapshot();
        const otherPath = join(root, 'other');
        await mkdir(otherPath);
        await writeFile(join(otherPath, 'file.txt'), 'other');
        const otherBinding = { ...binding, sessionId: 'other', worktreeId: null };
        await new CheckpointStore(checkpointRoot).snapshotTurn({ ...otherBinding, projectPath: otherPath, operationId: 'other' });
        await rm(projectPath, { recursive: true });
        const retention = new CheckpointRetention(checkpointRoot);
        await withCheckpointPin(checkpointRoot, { ...binding, checkpointId: id, operationId: 'restore' }, async () => {
            expect((await retention.retireWorktree({ ...request(), immediate: true, confirmed: true })).status).toBe('deferred');
            expect(await readFile(layout().metadataFile, 'utf8')).toContain('session');
        });
        await withCheckpointStaging(checkpointRoot, async () => {
            expect((await retention.collect()).prunedCheckpoints).toBe(0);
        });
        expect((await retention.collect()).prunedCheckpoints).toBe(1);
        expect(await readFile(resolveCheckpointStoreLayout({ checkpointRoot, ...otherBinding }).metadataFile, 'utf8')).toContain('other');
    });

    const operationRefs = async (key: string) => (await git('git', [`--git-dir=${layout().gitDirectory}`, 'for-each-ref',
        '--format=%(objectname)', `refs/saycode-checkpoint-operations/${key}`])).stdout.split('\n').filter(Boolean);
    const keyOf = (target: typeof binding) => {
        const ref = resolveCheckpointStoreLayout({ checkpointRoot, ...target }).refName;
        return ref.slice(ref.lastIndexOf('/') + 1);
    };
    const liveOther = async () => {
        const otherPath = join(root, 'repo', '.aplus', 'worktrees', 'project', 'other');
        const other = { ...binding, sessionId: 'other', worktreeId: 'other' };
        await mkdir(otherPath, { recursive: true });
        for (const version of ['one', 'two']) {
            await writeFile(join(otherPath, 'file.txt'), version);
            await new CheckpointStore(checkpointRoot).snapshotTurn({ ...other, projectPath: otherPath, operationId: version });
        }
        return other;
    };

    it('records absence only for a normal retirement, leaving other bindings and packing to the idle pass', async () => {
        await snapshot();
        const other = await liveOther();
        await rm(projectPath, { recursive: true });
        const later = Date.now() + 40 * 86400_000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
        try {
            expect((await new CheckpointRetention(checkpointRoot).retireWorktree(request())).status).toBe('retained');
        } finally { clock.mockRestore(); }
        const marker = JSON.parse(await readFile(join(layout().gitDirectory, 'retention', `${keyOf(binding)}.json`), 'utf8'));
        expect(marker).toEqual({ missingSince: later, immediate: false });
        expect(await operationRefs(keyOf(other))).toHaveLength(2);
        expect(await operationRefs(keyOf(binding))).toHaveLength(1);
    });

    it('deletes only the retired binding immediately and leaves object packing to the idle pass', async () => {
        const id = await snapshot();
        const other = await liveOther();
        await rm(projectPath, { recursive: true });
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 40 * 86400_000);
        try {
            expect((await new CheckpointRetention(checkpointRoot).retireWorktree({ ...request(), immediate: true, confirmed: true })).status)
                .toBe('deleted');
        } finally { clock.mockRestore(); }
        expect(await operationRefs(keyOf(binding))).toHaveLength(0);
        await expect(readFile(layout().metadataFile)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await operationRefs(keyOf(other))).toHaveLength(2);
        expect((await readdir(join(layout().gitDirectory, 'objects', 'pack'))).filter(name => name.endsWith('.pack'))).toEqual([]);
        await new CheckpointRetention(checkpointRoot).collect();
        await expect(git('git', [`--git-dir=${layout().gitDirectory}`, 'cat-file', '-e', id])).rejects.toThrow();
    });

    it('defers immediate retirement during staging or an incomplete restore, then the idle pass completes it', async () => {
        await snapshot();
        await rm(projectPath, { recursive: true });
        const retention = new CheckpointRetention(checkpointRoot);
        const immediate = { ...request(), immediate: true, confirmed: true };
        await withCheckpointStaging(checkpointRoot, async () => {
            expect((await retention.retireWorktree(immediate)).status).toBe('deferred');
        });
        const restores = join(layout().gitDirectory, 'restores', keyOf(binding));
        await mkdir(restores, { recursive: true });
        await writeFile(join(restores, 'journal.tmp'), '');
        expect((await retention.retireWorktree(immediate)).status).toBe('deferred');
        expect(await operationRefs(keyOf(binding))).toHaveLength(1);
        await rm(restores, { recursive: true });
        expect((await retention.collect()).prunedCheckpoints).toBe(1);
    });

    it('keeps an unreadable binding but continues automatic cleanup; explicit retirement stays fail-closed', async () => {
        await snapshot();
        const torn = join(layout().gitDirectory, 'bindings', `${'e'.repeat(64)}.json`);
        await writeFile(torn, '{"sessionId":"x"');
        await rm(projectPath, { recursive: true });
        const retention = new CheckpointRetention(checkpointRoot);
        await expect(retention.retireWorktree({ ...request(), action: 'inspect', immediate: true, confirmed: true })).rejects.toThrow('unreadable');
        await expect(retention.retireWorktree({ ...request(), immediate: true, confirmed: true })).rejects.toThrow('unreadable');
        expect(await operationRefs(keyOf(binding))).toHaveLength(1);
        const now = Date.now();
        await retention.collect(now);
        expect((await retention.collect(now + WORKTREE_HISTORY_GRACE_MS)).prunedCheckpoints).toBe(1);
        expect(await readFile(torn, 'utf8')).toBe('{"sessionId":"x"');
    });

    it('reclaims only stale private diff operands, keeping recent ones and symlink targets', async () => {
        await snapshot();
        const store = layout().gitDirectory;
        const outside = join(root, 'outside');
        await mkdir(outside);
        await writeFile(join(outside, 'keep.txt'), 'outside');
        const old = new Date(Date.now() - 2 * 3600_000);
        for (const name of ['diff-Stale1', 'diff-Fresh1']) {
            await mkdir(join(store, name));
            await writeFile(join(store, name, 'current'), 'private');
        }
        await utimes(join(store, 'diff-Stale1'), old, old);
        await symlink(outside, join(store, 'diff-Link01'));
        await new CheckpointRetention(checkpointRoot).collect();
        await expect(readdir(join(store, 'diff-Stale1'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(join(store, 'diff-Fresh1'))).toEqual(['current']);
        expect(await readFile(join(store, 'diff-Link01', 'keep.txt'), 'utf8')).toBe('outside');
        expect(await readFile(layout().metadataFile, 'utf8')).toContain('session');
    });
});
