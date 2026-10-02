import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCheckpointRuntime } from './checkpointRuntime';
import { CheckpointLedger } from './checkpointLedger';
import { CheckpointGarbageCollector } from './checkpointGarbageCollector';
import {
    CheckpointRestoreExecutor,
    type CheckpointRestoreMutation,
} from './checkpointRestore';
import { checkpointRestoreJournalPath, checkpointRestoreRequestFingerprint } from './checkpointRestoreJournal';
import { CheckpointRestorePlanner, type CheckpointRestorePlan } from './checkpointRestorePlan';
import {
    checkpointOperationRefPrefix,
    CheckpointStore,
    resolveCheckpointStoreLayout,
} from './checkpointStore';

const execFileAsync = promisify(execFile);

describe('CheckpointRestoreExecutor', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    };

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-restore-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        await mkdir(projectPath);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    async function createAgentModifiedPlan(): Promise<CheckpointRestorePlan> {
        await writeFile(join(projectPath, 'tracked.txt'), 'before\n');
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        await writeFile(join(projectPath, 'tracked.txt'), 'agent version\n');
        await new CheckpointLedger(checkpointRoot).recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'tracked.txt',
            action: 'written',
        });
        return new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: snapshot.checkpointId,
        });
    }

    async function createTwoFileAgentModifiedPlan(): Promise<CheckpointRestorePlan> {
        await writeFile(join(projectPath, 'a.txt'), 'a before\n');
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
        const ledger = new CheckpointLedger(checkpointRoot);
        await writeFile(join(projectPath, 'a.txt'), 'a agent\n');
        await ledger.recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-a',
            projectPath,
            path: 'a.txt',
            action: 'written',
        });
        await writeFile(join(projectPath, 'b.txt'), 'b agent-created\n');
        await ledger.recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-b',
            projectPath,
            path: 'b.txt',
            action: 'written',
        });
        return new CheckpointRestorePlanner(checkpointRoot).plan({
            ...binding,
            projectPath,
            checkpointId: snapshot.checkpointId,
        });
    }

    it('restores a checkpoint and then its safety checkpoint without claiming later user edits', async () => {
        const plan = await createAgentModifiedPlan();
        const executor = new CheckpointRestoreExecutor(checkpointRoot);
        const restored = await executor.execute({ ...binding, operationId: 'rewind-first', projectPath, plan, confirmed: true });
        if (restored.status !== 'completed') throw new Error('restore did not complete');
        const planner = new CheckpointRestorePlanner(checkpointRoot);
        const undo = await planner.plan({ ...binding, projectPath, checkpointId: restored.safetyCheckpointId });
        expect(undo.entries).toEqual([{ path: 'tracked.txt', action: 'restore', reason: 'agent-modified' }]);
        expect((await executor.execute({ ...binding, operationId: 'rewind-undo', projectPath, plan: undo, confirmed: true })).status).toBe('completed');
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('agent version\n');
        await writeFile(join(projectPath, 'tracked.txt'), 'user edit\n');
        expect((await planner.plan({ ...binding, projectPath, checkpointId: plan.checkpointId })).entries)
            .toEqual([{ path: 'tracked.txt', action: 'skip', reason: 'user-modified' }]);
    });

    it('does not treat a file omitted by a shifted capture limit as agent-created', async () => {
        await createAgentModifiedPlan();
        await writeFile(join(projectPath, 'aaa.txt'), 'user added');
        const runtime = await createCheckpointRuntime({ provider: 'codex', platform: 'darwin', projectPath,
            checkpointRoot, binding, protection: { secretPatterns: [], maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 4096 } });
        if (runtime.status !== 'protected') throw new Error('expected protected runtime');
        const target = await runtime.beforeTurn('shifted-limit');
        const plan = await new CheckpointRestorePlanner(checkpointRoot).plan({ ...binding, projectPath,
            checkpointId: target.checkpointId });
        expect(plan.entries).toContainEqual({ path: 'tracked.txt', action: 'skip', reason: 'provenance-unknown' });
        expect(plan.entries.some(entry => entry.path === 'tracked.txt' && entry.action === 'delete')).toBe(false);
        await new CheckpointRestoreExecutor(checkpointRoot).execute({ ...binding, projectPath, plan,
            operationId: 'rewind-shifted-limit', confirmed: true, excludedPaths: runtime.excludedPaths });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('agent version\n');
    });

    it('reconciles a successful mutation after a ledger failure without mutating it twice', async () => {
        const plan = await createAgentModifiedPlan();
        vi.spyOn(CheckpointLedger.prototype, 'recordMutation').mockRejectedValueOnce(new Error('fixture ledger failure'));
        const mutate = vi.fn(async (mutation: CheckpointRestoreMutation) => mutation.apply());
        const executor = new CheckpointRestoreExecutor(checkpointRoot, { mutate });
        const request = { ...binding, projectPath, plan, operationId: 'rewind-ledger-retry', confirmed: true };
        const partial = await executor.execute(request);
        expect(partial.status).toBe('partial');
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('before\n');
        const recovered = await executor.execute(request);
        if (recovered.status !== 'completed') throw new Error('retry did not reconcile');
        const undo = await new CheckpointRestorePlanner(checkpointRoot).plan({ ...binding, projectPath,
            checkpointId: recovered.safetyCheckpointId });
        expect(undo.entries[0].action).toBe('restore');
        await executor.execute({ ...request, operationId: 'undo-ledger-retry', plan: undo });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('agent version\n');
    });

    it('cancels before creating a safety checkpoint or mutating files', async () => {
        const plan = await createAgentModifiedPlan();

        const result = await new CheckpointRestoreExecutor(checkpointRoot).execute({
            ...binding,
            operationId: 'rewind-1',
            projectPath,
            plan,
            confirmed: false,
        });

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: checkpointCount } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        expect(result).toEqual({ status: 'cancelled' });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('agent version\n');
        expect(checkpointCount.trim().split('\n').filter(Boolean)).toHaveLength(1);
    });

    it('creates a safety checkpoint before applying a confirmed restore', async () => {
        const plan = await createAgentModifiedPlan();

        const result = await new CheckpointRestoreExecutor(checkpointRoot).execute({
            ...binding,
            operationId: 'rewind-1',
            projectPath,
            plan,
            confirmed: true,
        });

        expect(result).toMatchObject({
            status: 'completed',
            safetyCheckpointId: expect.stringMatching(/^[a-f0-9]{40,64}$/),
            entries: [{ path: 'tracked.txt', action: 'restore', outcome: 'restored' }],
        });
        if (result.status !== 'completed') throw new Error('expected completed restore');
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: safetyContents } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'show',
            `${result.safetyCheckpointId}:tracked.txt`,
        ]);
        expect(safetyContents).toBe('agent version\n');
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('before\n');
    });

    it('rejects a confirmed plan when files changed after preview', async () => {
        const plan = await createAgentModifiedPlan();
        await writeFile(join(projectPath, 'tracked.txt'), 'user edit after preview\n');

        const result = await new CheckpointRestoreExecutor(checkpointRoot).execute({
            ...binding,
            operationId: 'rewind-1',
            projectPath,
            plan,
            confirmed: true,
        });

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: checkpointCount } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        expect(result).toEqual({ status: 'stale-plan' });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe(
            'user edit after preview\n',
        );
        expect(checkpointCount.trim().split('\n').filter(Boolean)).toHaveLength(1);
    });

    it('preserves a user edit made after restore execution starts but before its file mutation', async () => {
        const plan = await createAgentModifiedPlan();
        const executor = new CheckpointRestoreExecutor(checkpointRoot, {
            mutate: async (mutation) => {
                await writeFile(join(projectPath, mutation.entry.path), 'concurrent user edit\n');
                await mutation.apply();
            },
        });

        const result = await executor.execute({
            ...binding,
            operationId: 'rewind-concurrent-user-edit',
            projectPath,
            plan,
            confirmed: true,
        });

        expect(result).toMatchObject({
            status: 'partial',
            entries: [{
                path: 'tracked.txt',
                action: 'restore',
                outcome: 'failed',
                failureCode: 'mutation-failed',
            }],
        });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe(
            'concurrent user edit\n',
        );
    });

    it('pins the restore target and safety checkpoint during concurrent garbage collection', async () => {
        const plan = await createAgentModifiedPlan();
        let gcResult: Awaited<ReturnType<CheckpointGarbageCollector['collect']>> | undefined;
        const executor = new CheckpointRestoreExecutor(checkpointRoot, {
            mutate: async (mutation) => {
                gcResult = await new CheckpointGarbageCollector(checkpointRoot).collect({
                    maxCheckpointsPerBinding: 0,
                });
                await mutation.apply();
            },
        });

        const result = await executor.execute({
            ...binding,
            operationId: 'rewind-with-concurrent-gc',
            projectPath,
            plan,
            confirmed: true,
        });

        expect(result).toMatchObject({ status: 'completed' });
        expect(gcResult).toMatchObject({ prunedCheckpoints: 0, retainedActive: 1 });
        if (result.status !== 'completed') throw new Error('expected completed restore');
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        await expect(execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'cat-file',
            '-e',
            `${result.safetyCheckpointId}^{commit}`,
        ])).resolves.toBeDefined();
    });

    it('migrates a legacy journal only with its matching current-policy fingerprint', async () => {
        const plan = await createAgentModifiedPlan();
        const request = { ...binding, projectPath, plan, operationId: 'legacy-policy-journal', confirmed: true };
        const executor = new CheckpointRestoreExecutor(checkpointRoot);
        await executor.execute(request);
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const journalFile = checkpointRestoreJournalPath(layout, request.operationId);
        const journal = JSON.parse(await readFile(journalFile, 'utf8'));
        const fingerprintInput = { ...binding, operationId: request.operationId, projectPath: await realpath(projectPath), plan };
        journal.requestFingerprint = checkpointRestoreRequestFingerprint({ ...fingerprintInput,
            excludedPaths: [], excludedPatterns: [] });
        await writeFile(journalFile, JSON.stringify(journal));
        await expect(executor.execute({ ...request, excludedPaths: ['changed-policy'] }))
            .rejects.toThrow('idempotency key conflict');
        await expect(executor.execute(request)).resolves.toMatchObject({ status: 'completed' });
        expect(JSON.parse(await readFile(journalFile, 'utf8')).requestFingerprint)
            .toBe(checkpointRestoreRequestFingerprint(fingerprintInput));
        await expect(executor.execute({ ...request, excludedPaths: ['changed-policy'] }))
            .resolves.toMatchObject({ status: 'completed' });
    });

    it('rechecks a newly excluded path on partial retry without losing its journal', async () => {
        const plan = await createAgentModifiedPlan();
        const request = { ...binding, projectPath, plan, operationId: 'retry-current-exclusion', confirmed: true };
        const failed = new CheckpointRestoreExecutor(checkpointRoot, { mutate: async () => { throw new Error('fail'); } });
        await expect(failed.execute(request)).resolves.toMatchObject({ status: 'partial' });
        const executor = new CheckpointRestoreExecutor(checkpointRoot);
        await expect(executor.execute({ ...request, excludedPaths: ['tracked.txt'] }))
            .resolves.toMatchObject({ status: 'partial' });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('agent version\n');
        await expect(executor.execute(request)).resolves.toMatchObject({ status: 'completed' });
    });

    it('journals partial failure and retries only failed entries with the same operation id', async () => {
        const plan = await createTwoFileAgentModifiedPlan();
        const attempts: string[] = [];
        let failAOnce = true;
        const executor = new CheckpointRestoreExecutor(checkpointRoot, {
            mutate: async (mutation: CheckpointRestoreMutation) => {
                attempts.push(mutation.entry.path);
                if (mutation.entry.path === 'a.txt' && failAOnce) {
                    failAOnce = false;
                    throw new Error('injected mutation failure');
                }
                await mutation.apply();
            },
        });
        const request = {
            ...binding,
            operationId: 'rewind-partial',
            projectPath,
            plan,
            confirmed: true,
        } as const;

        const first = await executor.execute(request);

        expect(first).toMatchObject({
            status: 'partial',
            safetyCheckpointId: expect.stringMatching(/^[a-f0-9]{40,64}$/),
            entries: [
                { path: 'a.txt', action: 'restore', outcome: 'failed' },
                { path: 'b.txt', action: 'delete', outcome: 'deleted' },
            ],
        });
        expect(await readFile(join(projectPath, 'a.txt'), 'utf8')).toBe('a agent\n');
        await expect(readFile(join(projectPath, 'b.txt'), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
        await writeFile(join(projectPath, 'b.txt'), 'b user edit after partial restore\n');

        const retry = await new CheckpointRestoreExecutor(checkpointRoot, {
            mutate: async (mutation: CheckpointRestoreMutation) => {
                attempts.push(mutation.entry.path);
                await mutation.apply();
            },
        }).execute({ ...request, excludedPaths: ['unrelated-new-secret.txt'] });

        expect(retry).toMatchObject({
            status: 'completed',
            safetyCheckpointId: first.status === 'partial' ? first.safetyCheckpointId : '',
            entries: [
                { path: 'a.txt', action: 'restore', outcome: 'restored' },
                { path: 'b.txt', action: 'delete', outcome: 'deleted' },
            ],
        });
        expect(attempts).toEqual(['a.txt', 'b.txt', 'a.txt']);
        expect(await readFile(join(projectPath, 'a.txt'), 'utf8')).toBe('a before\n');
        expect(await readFile(join(projectPath, 'b.txt'), 'utf8')).toBe(
            'b user edit after partial restore\n',
        );
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const { stdout: checkpointCount } = await execFileAsync('git', [
            `--git-dir=${layout.gitDirectory}`,
            'for-each-ref',
            '--format=%(objectname)',
            checkpointOperationRefPrefix(layout),
        ]);
        expect(checkpointCount.trim().split('\n').filter(Boolean)).toHaveLength(2);
    });

    it('fails closed when a durable journal contains an impossible action outcome', async () => {
        const plan = await createAgentModifiedPlan();
        const executor = new CheckpointRestoreExecutor(checkpointRoot);
        const request = {
            ...binding,
            operationId: 'rewind-corrupt',
            projectPath,
            plan,
            confirmed: true,
        } as const;
        await executor.execute(request);
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const journalFile = checkpointRestoreJournalPath(layout, request.operationId);
        const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
            entries: Array<{ action: string }>;
        };
        journal.entries[0].action = 'skip';
        await writeFile(journalFile, JSON.stringify(journal));

        await expect(executor.execute(request)).rejects.toThrow(
            'checkpoint restore journal is corrupt',
        );
    });

    it('fails closed when a durable journal no longer matches the approved plan', async () => {
        const plan = await createAgentModifiedPlan();
        const executor = new CheckpointRestoreExecutor(checkpointRoot);
        const request = {
            ...binding,
            operationId: 'rewind-journal-mismatch',
            projectPath,
            plan,
            confirmed: true,
        } as const;
        await executor.execute(request);
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const journalFile = checkpointRestoreJournalPath(layout, request.operationId);
        const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
            entries: Array<{ path: string }>;
        };
        journal.entries[0].path = 'different.txt';
        await writeFile(journalFile, JSON.stringify(journal));

        await expect(executor.execute(request)).rejects.toThrow(
            'checkpoint restore journal does not match plan',
        );
    });

    it('does not reapply a mutation left in an uncertain applying state after restart', async () => {
        const plan = await createAgentModifiedPlan();
        const request = {
            ...binding,
            operationId: 'rewind-interrupted',
            projectPath,
            plan,
            confirmed: true,
        } as const;
        await new CheckpointRestoreExecutor(checkpointRoot).execute(request);
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        const journalFile = checkpointRestoreJournalPath(layout, request.operationId);
        const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
            entries: Array<{ outcome: string }>;
        };
        journal.entries[0].outcome = 'applying';
        await writeFile(journalFile, JSON.stringify(journal));
        await writeFile(join(projectPath, 'tracked.txt'), 'user edit after interruption\n');

        const retry = await new CheckpointRestoreExecutor(checkpointRoot).execute(request);

        expect(retry).toMatchObject({
            status: 'partial',
            entries: [{
                path: 'tracked.txt',
                action: 'restore',
                outcome: 'failed',
                failureCode: 'mutation-outcome-unknown',
            }],
        });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe(
            'user edit after interruption\n',
        );
    });

    it('serializes different restore operations targeting the same project', async () => {
        const plan = await createAgentModifiedPlan();
        const attempts: string[] = [];
        let releaseFirstMutation!: () => void;
        const firstMutationRelease = new Promise<void>((resolvePromise) => {
            releaseFirstMutation = resolvePromise;
        });
        let notifySecondMutation!: () => void;
        const secondMutationStarted = new Promise<void>((resolvePromise) => {
            notifySecondMutation = resolvePromise;
        });
        const executor = new CheckpointRestoreExecutor(checkpointRoot, {
            mutate: async (mutation: CheckpointRestoreMutation) => {
                attempts.push(mutation.entry.path);
                if (attempts.length === 1) {
                    await firstMutationRelease;
                } else {
                    notifySecondMutation();
                }
                await mutation.apply();
            },
        });
        const first = executor.execute({
            ...binding,
            operationId: 'rewind-concurrent-1',
            projectPath,
            plan,
            confirmed: true,
        });
        while (attempts.length === 0) await new Promise(setImmediate);
        const second = executor.execute({
            ...binding,
            operationId: 'rewind-concurrent-2',
            projectPath,
            plan,
            confirmed: true,
        });
        await Promise.race([
            secondMutationStarted,
            new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100)),
        ]);
        releaseFirstMutation();

        const results = await Promise.all([first, second]);

        expect(results.map((result) => result.status)).toEqual(['completed', 'stale-plan']);
        expect(attempts).toEqual(['tracked.txt']);
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('before\n');
    });
});
