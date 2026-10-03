import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointLedger } from './checkpointLedger';
import { CheckpointRestorePlanner } from './checkpointRestorePlan';
import { CheckpointStore, resolveCheckpointStoreLayout } from './checkpointStore';

const execFileAsync = promisify(execFile);

describe('CheckpointRestorePlanner', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    };

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-restore-plan-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        await mkdir(projectPath);
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('never turns a historical symlink into a restorable regular-file operation', async () => {
        await symlink('outside-target', join(projectPath, 'link.txt'));
        const target = await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, projectPath, operationId: 'symlink-target' });
        await unlink(join(projectPath, 'link.txt'));
        await writeFile(join(projectPath, 'link.txt'), 'agent regular file');
        await new CheckpointLedger(checkpointRoot).recordMutation({ ...binding, projectPath, operationId: 'agent-edit',
            mutationId: 'write-link', path: 'link.txt', action: 'written' });
        expect((await new CheckpointRestorePlanner(checkpointRoot).plan({ ...binding, projectPath,
            checkpointId: target.checkpointId })).entries).toEqual([{ path: 'link.txt', action: 'conflict', reason: 'unsafe-path' }]);
    });

    it('skips a file that the user edited after the recorded agent write', async () => {
        const store = new CheckpointStore(checkpointRoot);
        const ledger = new CheckpointLedger(checkpointRoot);
        await writeFile(join(projectPath, 'tracked.txt'), 'before\n');
        const snapshot = await store.snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        await writeFile(join(projectPath, 'tracked.txt'), 'agent version\n');
        await ledger.recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'tracked.txt',
            action: 'written',
        });
        await writeFile(join(projectPath, 'tracked.txt'), 'user version\n');

        const plan = await new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: snapshot.checkpointId,
        });

        expect(plan.entries).toEqual([{
            path: 'tracked.txt',
            action: 'skip',
            reason: 'user-modified',
        }]);
    });

    it('captures the current files in a separate checkpoint before restore', async () => {
        const planner = new CheckpointRestorePlanner(checkpointRoot);
        await writeFile(join(projectPath, 'tracked.txt'), 'restore target\n');
        const target = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        await writeFile(join(projectPath, 'tracked.txt'), 'state before restore\n');

        const safety = await planner.checkpointBeforeRestore({
            ...binding,
            operationId: 'rewind-1',
            projectPath,
        });

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'show',
            `${safety.checkpointId}:tracked.txt`,
        ]);
        expect(safety.checkpointId).not.toBe(target.checkpointId);
        expect(stdout).toBe('state before restore\n');
    });

    it('skips a changed file without agent provenance', async () => {
        await writeFile(join(projectPath, 'user.txt'), 'before\n');
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        await writeFile(join(projectPath, 'user.txt'), 'user version\n');

        const plan = await new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: snapshot.checkpointId,
        });

        expect(plan.entries).toEqual([{
            path: 'user.txt',
            action: 'skip',
            reason: 'provenance-unknown',
        }]);
    });

    it('deletes an unchanged agent-created file that is absent from the checkpoint', async () => {
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        await writeFile(join(projectPath, 'agent.txt'), 'agent version\n');
        await new CheckpointLedger(checkpointRoot).recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'agent.txt',
            action: 'written',
        });

        const plan = await new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: snapshot.checkpointId,
        });

        expect(plan.entries).toEqual([{
            path: 'agent.txt',
            action: 'delete',
            reason: 'agent-created',
        }]);
    });

    it('restores a checkpoint file with an agent delete tombstone', async () => {
        await writeFile(join(projectPath, 'deleted.txt'), 'before\n');
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        await unlink(join(projectPath, 'deleted.txt'));
        await new CheckpointLedger(checkpointRoot).recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'deleted.txt',
            action: 'deleted',
        });

        const plan = await new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: snapshot.checkpointId,
        });

        expect(plan.entries).toEqual([{
            path: 'deleted.txt',
            action: 'restore',
            reason: 'agent-deleted',
        }]);
    });

    it('rejects a checkpoint owned by another session and project binding', async () => {
        await writeFile(join(projectPath, 'tracked.txt'), 'first project\n');
        await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        const otherProjectPath = join(fixtureRoot, 'other-project');
        await mkdir(otherProjectPath);
        await writeFile(join(otherProjectPath, 'tracked.txt'), 'other project\n');
        const other = await new CheckpointStore(checkpointRoot).snapshotTurn({
            sessionId: 'session-2',
            projectId: 'project-2',
            worktreeId: null,
            operationId: 'turn-1',
            projectPath: otherProjectPath,
        });

        await expect(new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: other.checkpointId,
        })).rejects.toThrow('checkpoint restore target does not belong to binding');
    });

    it('omits an agent-created file that is already absent like the checkpoint', async () => {
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        await writeFile(join(projectPath, 'agent.txt'), 'agent version\n');
        await new CheckpointLedger(checkpointRoot).recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'agent.txt',
            action: 'written',
        });
        await unlink(join(projectPath, 'agent.txt'));

        const plan = await new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: snapshot.checkpointId,
        });

        expect(plan.entries).toEqual([]);
    });

    it('reports a conflict instead of following a symlinked parent outside the project', async () => {
        await mkdir(join(projectPath, 'src'));
        await writeFile(join(projectPath, 'src', 'tracked.txt'), 'before\n');
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        await writeFile(join(projectPath, 'src', 'tracked.txt'), 'agent version\n');
        await new CheckpointLedger(checkpointRoot).recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'src/tracked.txt',
            action: 'written',
        });
        const outsidePath = join(fixtureRoot, 'outside');
        await mkdir(outsidePath);
        await writeFile(join(outsidePath, 'tracked.txt'), 'agent version\n');
        await rm(join(projectPath, 'src'), { recursive: true });
        await symlink(outsidePath, join(projectPath, 'src'), 'dir');

        const plan = await new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: snapshot.checkpointId,
        });

        expect(plan.entries).toContainEqual({
            path: 'src/tracked.txt',
            action: 'conflict',
            reason: 'unsafe-path',
        });
        expect(plan.entries).not.toContainEqual({
            path: 'src/tracked.txt',
            action: 'restore',
            reason: 'agent-modified',
        });
    });
});
