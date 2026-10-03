import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CheckpointGarbageCollector,
    withCheckpointPin,
} from './checkpointGarbageCollector';
import { CheckpointStore, resolveCheckpointStoreLayout } from './checkpointStore';
import { withCheckpointStaging, withCheckpointStoreLock } from './checkpointStoreLock';

const execFileAsync = promisify(execFile);

describe('CheckpointGarbageCollector', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    } as const;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-gc-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        await mkdir(projectPath);
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('keeps an active restore checkpoint while pruning count-expired checkpoints', async () => {
        const store = new CheckpointStore(checkpointRoot);
        const checkpoints: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            await writeFile(join(projectPath, 'tracked.txt'), `version ${index}\n`);
            checkpoints.push((await store.snapshotTurn({
                ...binding,
                projectPath,
                operationId: `turn-${index}`,
            })).checkpointId);
        }
        const collector = new CheckpointGarbageCollector(checkpointRoot);

        await withCheckpointPin(checkpointRoot, {
            ...binding,
            checkpointId: checkpoints[0]!,
            operationId: 'restore-active',
        }, async () => {
            const result = await collector.collect({ maxCheckpointsPerBinding: 0 });

            expect(result).toMatchObject({ prunedCheckpoints: 0, retainedActive: 1 });
            await expectObject(checkpointRoot, binding, checkpoints[0]!, true);
            await expectObject(checkpointRoot, binding, checkpoints[1]!, true);
            await expectObject(checkpointRoot, binding, checkpoints[2]!, true);
        });

        const result = await collector.collect({ maxCheckpointsPerBinding: 0 });
        expect(result).toMatchObject({ prunedCheckpoints: 3, retainedActive: 0 });
        await expectObject(checkpointRoot, binding, checkpoints[0]!, false);
    });

    it('preserves latest baseline and latest safety above age, count and soft capacity', async () => {
        const store = new CheckpointStore(checkpointRoot);
        const ids: string[] = [];
        for (const [index, record] of (['before', 'safety', 'after'] as const).entries()) {
            await writeFile(join(projectPath, 'tracked.txt'), `version ${index}`);
            ids.push((await store.snapshotTurn({ ...binding, projectPath, operationId: `protected-${index}`,
                workTree: { maxFileBytes: 1024, record } })).checkpointId);
        }
        const result = await new CheckpointGarbageCollector(checkpointRoot).collect({
            maxCheckpointsPerBinding: 0, maxAgeMs: 0, now: Date.now() + 10_000,
            maxStoreBytes: 0, preserveLatest: true,
        });
        expect(result.prunedCheckpoints).toBe(1);
        await expectObject(checkpointRoot, binding, ids[0]!, false);
        await expectObject(checkpointRoot, binding, ids[1]!, true);
        await expectObject(checkpointRoot, binding, ids[2]!, true);
        expect(result.storeBytes).toBeGreaterThan(0);
    });

    it('stops capacity reclamation once the pass budget is spent and resumes on the next pass', async () => {
        const store = new CheckpointStore(checkpointRoot);
        for (let index = 0; index < 3; index += 1) {
            await writeFile(join(projectPath, 'tracked.txt'), `version ${index}`);
            await store.snapshotTurn({ ...binding, projectPath, operationId: `budget-${index}` });
        }
        const collector = new CheckpointGarbageCollector(checkpointRoot);
        const policy = { maxStoreBytes: 0, preserveLatest: true } as const;
        expect((await collector.collect({ ...policy, capacityBudgetMs: 0 })).prunedCheckpoints).toBe(0);
        expect((await collector.collect({ ...policy, capacityBudgetMs: 60_000 })).prunedCheckpoints).toBe(2);
    });

    it('refuses to create a pin for a checkpoint owned by another binding', async () => {
        await writeFile(join(projectPath, 'tracked.txt'), 'owned\n');
        const checkpointId = (await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            projectPath,
            operationId: 'turn-owned',
        })).checkpointId;
        let invoked = false;

        await expect(withCheckpointPin(checkpointRoot, {
            ...binding,
            projectId: 'other-project',
            checkpointId,
            operationId: 'restore-foreign',
        }, async () => {
            invoked = true;
        })).rejects.toThrow('does not belong to binding');
        expect(invoked).toBe(false);
    });

    it('keeps overlapping pins with the same operation isolated', async () => {
        await writeFile(join(projectPath, 'tracked.txt'), 'owned\n');
        const checkpointId = (await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            projectPath,
            operationId: 'turn-overlapping-pins',
        })).checkpointId;
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const firstRelease = new Promise<void>((resolve) => { finishFirst = resolve; });
        const secondRelease = new Promise<void>((resolve) => { finishSecond = resolve; });
        let markFirstStarted!: () => void;
        let markSecondStarted!: () => void;
        const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
        const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
        const request = {
            ...binding,
            checkpointId,
            operationId: 'restore-overlapping',
        };
        const first = withCheckpointPin(checkpointRoot, request, async () => {
            markFirstStarted();
            await firstRelease;
        });
        const second = withCheckpointPin(checkpointRoot, request, async () => {
            markSecondStarted();
            await secondRelease;
        });
        await Promise.all([firstStarted, secondStarted]);

        finishFirst();
        await first;
        try {
            const result = await new CheckpointGarbageCollector(checkpointRoot).collect({
                maxCheckpointsPerBinding: 0,
            });

            expect(result).toMatchObject({ prunedCheckpoints: 0, retainedActive: 1 });
        } finally {
            finishSecond();
            await second;
        }
    });

    // A whole-folder record hashes outside the store lock; its fresh objects are not referenced yet.
    it('keeps objects written after an in-flight staging began until it finishes', async () => {
        await writeFile(join(projectPath, 'tracked.txt'), 'owned\n');
        await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, projectPath, operationId: 'turn-1' });
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const staged = async () => {
            const child = execFile('git', [`--git-dir=${layout.gitDirectory}`, 'hash-object', '-w', '--stdin']);
            child.stdin!.end('staged but not committed\n');
            return (await new Promise<string>((resolve) => { let out = ''; child.stdout!.on('data', (chunk) => { out += chunk; }); child.on('close', () => resolve(out.trim())); }));
        };
        const exists = (id: string) => execFileAsync('git', [`--git-dir=${layout.gitDirectory}`, 'cat-file', '-e', id]).then(() => true, () => false);

        const kept = await withCheckpointStaging(checkpointRoot, async () => {
            const id = await staged();
            await new CheckpointGarbageCollector(checkpointRoot).collect({ maxCheckpointsPerBinding: 0 });
            return id;
        });
        expect(await exists(kept)).toBe(true);

        await writeFile(join(projectPath, 'tracked.txt'), 'owned again\n');
        await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, projectPath, operationId: 'turn-2' });
        await new CheckpointGarbageCollector(checkpointRoot).collect({ maxCheckpointsPerBinding: 0 });
        expect(await exists(kept)).toBe(false);
    });

    it('waits for an in-flight store writer before destructive collection', async () => {
        await writeFile(join(projectPath, 'tracked.txt'), 'owned\n');
        await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            projectPath,
            operationId: 'turn-before-store-lock',
        });
        let releaseWriter!: () => void;
        const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
        let markWriterStarted!: () => void;
        const writerStarted = new Promise<void>((resolve) => { markWriterStarted = resolve; });
        const writer = withCheckpointStoreLock(checkpointRoot, async () => {
            markWriterStarted();
            await writerRelease;
        });
        await writerStarted;
        let collectionSettled = false;
        const collection = new CheckpointGarbageCollector(checkpointRoot)
            .collect({ maxCheckpointsPerBinding: 0 })
            .finally(() => { collectionSettled = true; });

        try {
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(collectionSettled).toBe(false);
        } finally {
            releaseWriter();
            await writer;
        }
        await expect(collection).resolves.toMatchObject({ prunedCheckpoints: 1 });
    });

    it('retains the newest checkpoint when the wall clock does not advance', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        try {
            const store = new CheckpointStore(checkpointRoot);
            const checkpoints: string[] = [];
            for (let index = 0; index < 3; index += 1) {
                await writeFile(join(projectPath, 'tracked.txt'), `version ${index}\n`);
                checkpoints.push((await store.snapshotTurn({
                    ...binding,
                    projectPath,
                    operationId: `turn-same-clock-${index}`,
                })).checkpointId);
            }

            const result = await new CheckpointGarbageCollector(checkpointRoot).collect({
                maxCheckpointsPerBinding: 1,
            });

            expect(result.prunedCheckpoints).toBe(2);
            await expectObject(checkpointRoot, binding, checkpoints[0]!, false);
            await expectObject(checkpointRoot, binding, checkpoints[1]!, false);
            await expectObject(checkpointRoot, binding, checkpoints[2]!, true);
        } finally {
            clock.mockRestore();
        }
    });

    it.each([
        ['age', { maxAgeMs: 0 }],
        ['capacity', { maxStoreBytes: 0 }],
    ] as const)('reclaims checkpoints using the explicit %s limit', async (_name, policy) => {
        const store = new CheckpointStore(checkpointRoot);
        const checkpoints: string[] = [];
        for (let index = 0; index < 2; index += 1) {
            await writeFile(join(projectPath, 'tracked.txt'), `version ${index}\n`);
            checkpoints.push((await store.snapshotTurn({
                ...binding,
                projectPath,
                operationId: `turn-policy-${index}`,
            })).checkpointId);
        }

        const result = await new CheckpointGarbageCollector(checkpointRoot).collect({ ...policy, now: Date.now() + 10_000 });

        expect(result.prunedCheckpoints).toBe(2);
        for (const checkpointId of checkpoints) {
            await expectObject(checkpointRoot, binding, checkpointId, false);
        }
    });
});

async function expectObject(
    checkpointRoot: string,
    binding: { sessionId: string; projectId: string; worktreeId: string | null },
    checkpointId: string,
    exists: boolean,
): Promise<void> {
    const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
    const result = await execFileAsync('git', [
        `--git-dir=${layout.gitDirectory}`,
        'cat-file',
        '-e',
        `${checkpointId}^{commit}`,
    ]).then(() => true, () => false);
    expect(result).toBe(exists);
}
