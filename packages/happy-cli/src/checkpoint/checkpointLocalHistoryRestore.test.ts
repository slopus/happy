import { CheckpointGarbageCollector } from './checkpointGarbageCollector';
import { CheckpointStore } from './checkpointStore';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckpointLocalHistory, type CheckpointLocalHistory } from './checkpointLocalHistory';
import { CheckpointRestoreExecutor } from './checkpointRestore';
import { CheckpointRestorePlanner } from './checkpointRestorePlan';

// specs/checkpoint-local-history R4 — a local-history checkpoint restores what this conversation's
// turns changed and, by default, keeps anything changed after its last record.
// Each case drives several real git records and restores; the default 5s is too tight under suite load.
describe('local history restore', { timeout: 20_000 }, () => {
    let fixtureRoot: string;
    let projectPath: string;
    let checkpointRoot: string;
    const checkpointEvents = { snapshot: async () => ({ id: 'event', seq: 1, createdAt: Date.now(), idempotent: false }) };
    const excludedPatterns = ['.env*', '.aplus/worktrees/'];

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-local-history-restore-'));
        projectPath = join(fixtureRoot, 'project');
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        await mkdir(projectPath);
        await mkdir(checkpointRoot);
        projectPath = await realpath(projectPath);
        checkpointRoot = await realpath(checkpointRoot);
        await writeFile(join(projectPath, 'keep.txt'), 'keep');
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    const binding = (sessionId = 'session-1') => ({ sessionId, projectId: 'project-1', worktreeId: null, projectPath });
    const history = (sessionId = 'session-1'): CheckpointLocalHistory => createCheckpointLocalHistory({
        binding: { sessionId, projectId: 'project-1', worktreeId: null },
        checkpointRoot,
        projectPath,
        secretPatterns: ['.env*'],
        checkpointEvents,
    });
    const turn = async (recorder: CheckpointLocalHistory, write: () => Promise<void>) => {
        const { checkpointId } = await recorder.beforeTurn();
        await write();
        await recorder.afterTurn();
        return checkpointId;
    };
    const preview = (checkpointId: string, sessionId = 'session-1', includePaths?: string[]) =>
        new CheckpointRestorePlanner(checkpointRoot).planWithDetails({
            ...binding(sessionId), checkpointId, excludedPatterns, includePaths,
        });
    const restore = async (checkpointId: string, operationId: string, sessionId = 'session-1', includePaths?: string[]) => {
        const { plan } = await preview(checkpointId, sessionId, includePaths);
        const result = await new CheckpointRestoreExecutor(checkpointRoot).execute({
            ...binding(sessionId), operationId, plan, confirmed: true, excludedPatterns, includePaths,
            localHistory: { maxFileBytes: 10 * 1024 * 1024 },
        });
        if (result.status !== 'completed') throw new Error(`restore ${result.status}`);
        return result;
    };

    it('restores, deletes and undoes the files the turns changed', async () => {
        const recorder = history();
        const first = await turn(recorder, () => writeFile(join(projectPath, 'b.html'), 'hello world'));
        const second = await turn(recorder, () => writeFile(join(projectPath, 'b.html'), 'hello buzzni'));

        expect((await preview(second)).plan.entries).toEqual([{ path: 'b.html', action: 'restore', reason: 'agent-modified' }]);
        const restored = await restore(second, 'restore-1');
        expect(await readFile(join(projectPath, 'b.html'), 'utf8')).toBe('hello world');

        expect((await preview(first)).plan.entries).toEqual([{ path: 'b.html', action: 'delete', reason: 'agent-created' }]);
        await restore(first, 'restore-2');
        await expect(readFile(join(projectPath, 'b.html'), 'utf8')).rejects.toThrow();

        await restore(restored.safetyCheckpointId, 'undo-1');
        expect(await readFile(join(projectPath, 'b.html'), 'utf8')).toBe('hello buzzni');
        expect(await readFile(join(projectPath, 'keep.txt'), 'utf8')).toBe('keep');
    });

    it('keeps a file changed after the last record unless the user includes it', async () => {
        const recorder = history();
        const start = await turn(recorder, () => writeFile(join(projectPath, 'c.txt'), 'agent'));
        await writeFile(join(projectPath, 'c.txt'), 'user');

        const { plan, details } = await preview(start);
        expect(plan.entries).toEqual([{ path: 'c.txt', action: 'skip', reason: 'user-modified' }]);
        expect(details).toEqual([{ path: 'c.txt', detail: 'changed-after-record' }]);

        await restore(start, 'restore-include', 'session-1', ['c.txt']);
        await expect(readFile(join(projectPath, 'c.txt'), 'utf8')).rejects.toThrow();
    });

    it('leaves another conversation’s later change in the same folder alone', async () => {
        const mine = history('session-a');
        const theirs = history('session-b');
        const start = await turn(mine, () => writeFile(join(projectPath, 'a.txt'), 'mine'));
        await turn(theirs, () => writeFile(join(projectPath, 'b.txt'), 'theirs'));

        const { plan } = await preview(start, 'session-a');
        expect(plan.entries).toEqual([
            { path: 'a.txt', action: 'delete', reason: 'agent-created' },
            { path: 'b.txt', action: 'skip', reason: 'user-modified' },
        ]);
        await restore(start, 'restore-a', 'session-a');
        expect(await readFile(join(projectPath, 'b.txt'), 'utf8')).toBe('theirs');
    });

    it('keeps edits whose intervening records were pruned until explicitly included', async () => {
        const store = new CheckpointStore(checkpointRoot);
        const snapshot = (operationId: string, record: 'safety' | 'before' | 'after') => store.snapshotTurn({
            ...binding(), operationId, workTree: { maxFileBytes: 1024, record },
        });
        await writeFile(join(projectPath, 'between.txt'), 'old');
        const target = await snapshot('safety', 'safety');
        await writeFile(join(projectPath, 'between.txt'), 'user edit');
        await snapshot('before', 'before');
        await snapshot('after', 'after');
        await new CheckpointGarbageCollector(checkpointRoot).collect({ maxCheckpointsPerBinding: 1, preserveLatest: true });
        expect((await preview(target.checkpointId)).plan.entries).toContainEqual({ path: 'between.txt', action: 'skip', reason: 'user-modified' });
        expect((await preview(target.checkpointId, 'session-1', ['between.txt'])).plan.entries).toContainEqual({ path: 'between.txt', action: 'restore', reason: 'agent-modified' });
    });

    it('keeps an edit made between this conversation’s turns, even though the next turn recorded it', async () => {
        const recorder = history();
        const start = await turn(recorder, () => writeFile(join(projectPath, 'a.txt'), 'turn 1'));
        await writeFile(join(projectPath, 'between.txt'), 'edited between turns');
        await turn(recorder, () => writeFile(join(projectPath, 'a.txt'), 'turn 2'));

        const { plan, details } = await preview(start);
        expect(plan.entries).toEqual([
            { path: 'a.txt', action: 'delete', reason: 'agent-created' },
            { path: 'between.txt', action: 'skip', reason: 'user-modified' },
        ]);
        expect(details).toEqual([{ path: 'between.txt', detail: 'changed-after-record' }]);
        await restore(start, 'restore-between');
        expect(await readFile(join(projectPath, 'between.txt'), 'utf8')).toBe('edited between turns');
    });

    it('marks files the record left out instead of touching them', async () => {
        const recorder = history();
        await writeFile(join(projectPath, '.env.local'), 'TOKEN=1');
        const start = await turn(recorder, () => writeFile(join(projectPath, '.env.local'), 'TOKEN=2'));

        const { plan, details } = await preview(start);
        expect(plan.entries).toEqual([{ path: '.env.local', action: 'skip', reason: 'provenance-unknown' }]);
        expect(details).toEqual([{ path: '.env.local', detail: 'not-recorded' }]);
        await restore(start, 'restore-secret');
        expect(await readFile(join(projectPath, '.env.local'), 'utf8')).toBe('TOKEN=2');
    });

    it('accepts a plan from a Desktop that never saw the skip details', async () => {
        const recorder = history();
        const start = await turn(recorder, async () => {
            await writeFile(join(projectPath, 'a.txt'), 'agent');
            await writeFile(join(projectPath, 'c.txt'), 'agent');
        });
        await writeFile(join(projectPath, 'c.txt'), 'user');
        const { plan } = await preview(start);

        const result = await new CheckpointRestoreExecutor(checkpointRoot).execute({
            ...binding(), operationId: 'old-desktop', plan: JSON.parse(JSON.stringify(plan)), confirmed: true, excludedPatterns,
            localHistory: { maxFileBytes: 10 * 1024 * 1024 },
        });

        expect(result.status).toBe('completed');
        await expect(readFile(join(projectPath, 'a.txt'), 'utf8')).rejects.toThrow();
        expect(await readFile(join(projectPath, 'c.txt'), 'utf8')).toBe('user');
    });
});
