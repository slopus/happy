import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@/app/aiServices/testDatabase';
import { createScheduledTaskStore } from './store';
import { SCHEDULED_TASK_PREFIX, SCHEDULED_RUN_AUDIT_LIMIT, ScheduledRunSchema, type ScheduledRunAuditEntry, type ScheduledTaskInput, type ScheduledTask } from '@slopus/happy-wire';

describe('durable scheduled tasks', () => {
    let context: Awaited<ReturnType<typeof createTestDatabase>>;
    let store: ReturnType<typeof createScheduledTaskStore>;
    let owner: string, other: string, machine: string, now: number;
    let input: ScheduledTaskInput;
    beforeAll(async () => { context = await createTestDatabase(); }, 120000);
    beforeEach(async () => {
        owner = randomUUID(); other = randomUUID(); machine = randomUUID(); now = 1_800_000_000_000;
        for (const id of [owner, other]) await context.database.account.create({ data: { id, publicKey: id } });
        await context.database.machine.create({ data: { id: machine, accountId: owner, metadata: 'encrypted' } });
        store = createScheduledTaskStore(context.database, { now: () => now });
        input = { id: randomUUID(), machineId: machine, rule: { type: 'interval', anchor: now + 1000, hours: 1, timezone: 'UTC' },
            enabled: true, encryptedConfig: 'opaque-ciphertext', newChatEachRun: true, notificationPolicy: 'important' };
    });
    afterAll(async () => { await context?.database.$disconnect(); await context?.pg.close(); });

    it('gates locally registered executors by capability and keeps their terminal contract separate from agent turns', async () => {
        await store.save(owner, { ...input, executionKind: 'local-handler', enabled: false }, -1);
        const token = (await store.configureWebhook(owner, input.id, true)).token!;
        const requestId = randomUUID();
        const run = await store.runNow(owner, input.id, requestId, { token, input: { jobId: randomUUID() } });
        const queuedAt = now;
        expect(await store.claim(owner, machine, 1)).toEqual([]);
        now += 1000;
        const [claim] = await store.claim(owner, machine, 1, 1);
        expect(claim).toMatchObject({ executionKind: 'local-handler', webhookRequestId: requestId, deliveryAuthorized: true });
        await expect(store.report(owner, input.id, run.id, { claimId: claim.claimId!, status: 'waiting-for-input' })).rejects.toMatchObject({ code: 'local-handler-binding-invalid' });
        now += 1000;
        await store.report(owner, input.id, run.id, { claimId: claim.claimId!, status: 'running', sequence: 1 });
        now += 1000;
        await store.report(owner, input.id, run.id, { claimId: claim.claimId!, status: 'running', sequence: 2 });
        now += 1000;
        await store.report(owner, input.id, run.id, { claimId: claim.claimId!, status: 'completed', sequence: 3 });
        await store.report(owner, input.id, run.id, { claimId: claim.claimId!, status: 'completed', sequence: 3 });
        const restored = createScheduledTaskStore(context.database);
        const [record] = await restored.history(owner, input.id);
        expect(ScheduledRunSchema.parse(record)).toMatchObject({ trigger: 'webhook', audit: [
            { status: 'pending', at: queuedAt, reason: null },
            { status: 'claimed', at: queuedAt + 1000, reason: null },
            { status: 'running', at: queuedAt + 2000, reason: null },
            { status: 'completed', at: queuedAt + 4000, reason: null },
        ] });
        await expect(restored.history(other, input.id)).rejects.toMatchObject({ code: 'task-not-found' });
        const snapshot = await store.webhookSnapshot(owner, input.id);
        expect(snapshot).toEqual({ activeRunId: null, runs: [{ runId: run.id, requestId, status: 'completed', reason: null, updatedAt: now }] });
        expect(JSON.stringify(snapshot)).not.toContain('opaque-ciphertext');
        const normal = await store.save(owner, { ...input, id: randomUUID() }, -1);
        const agentRun = await store.runNow(owner, normal.id, randomUUID());
        const [agentClaim] = await store.claim(owner, machine, 1, 1);
        await expect(store.report(owner, normal.id, agentRun.id, { claimId: agentClaim.claimId!, status: 'completed' })).rejects.toMatchObject({ code: 'turn-required' });
    });

    it('retains registered execution when an old client omits the execution kind during a schedule update', async () => {
        const task = await store.save(owner, { ...input, executionKind: 'local-handler' }, -1);
        await expect(store.save(owner, { ...input, newChatEachRun: false }, task.version))
            .rejects.toMatchObject({ code: 'local-handler-requires-independent-runs' });
        const paused = await store.save(owner, { ...input, enabled: false }, task.version);
        expect(paused.executionKind).toBe('local-handler');
        const run = await store.runNow(owner, input.id, randomUUID());
        expect(run.executionKind).toBe('local-handler');
        expect(await store.claim(owner, machine)).toEqual([]);
        expect(await store.claim(owner, machine, undefined, 1)).toHaveLength(1);
        const [current] = await store.list(owner);
        const switched = await store.save(owner, { ...input, executionKind: 'agent' }, current.version);
        expect(switched.executionKind).toBe('agent');
    });

    it('records new transitions on legacy runs without inventing old audit rows or a trigger', async () => {
        await store.save(owner, input, -1);
        const requestId = randomUUID();
        const run = await store.runNow(owner, input.id, requestId);
        const key = `${SCHEDULED_TASK_PREFIX}run:${input.id}:${run.id}`;
        const legacy = { ...run };
        delete legacy.audit;
        delete legacy.trigger;
        await context.database.userKVStore.update({
            where: { accountId_key: { accountId: owner, key } },
            data: { value: new TextEncoder().encode(JSON.stringify(legacy)) },
        });
        const [before] = await store.history(owner, input.id);
        expect(ScheduledRunSchema.parse(before)).not.toHaveProperty('audit');
        expect((await store.runNow(owner, input.id, requestId)).id).toBe(run.id);
        now += 1000;
        const [claim] = await store.claim(owner, machine);
        expect(claim).not.toHaveProperty('trigger');
        expect(claim.audit).toEqual([{ at: now, status: 'claimed', reason: null }]);
        const reason = 'external receipt data must not be copied to audit';
        await store.report(owner, input.id, run.id, { claimId: claim.claimId!, status: 'failed', reason });
        const [after] = await store.history(owner, input.id);
        expect(after.reason).toBe(reason);
        expect(after.audit?.at(-1)).toEqual({ at: now, status: 'failed', reason: null });
    });

    it('bounds audit history while retaining the first event and latest transitions', async () => {
        await store.save(owner, input, -1);
        const run = await store.runNow(owner, input.id, randomUUID());
        const [claim] = await store.claim(owner, machine);
        const audit: ScheduledRunAuditEntry[] = [...claim.audit!];
        for (let index = audit.length; index < SCHEDULED_RUN_AUDIT_LIMIT; index++) {
            audit.push({ at: now + index, status: index % 2 ? 'running' : 'waiting-for-input', reason: null });
        }
        const key = `${SCHEDULED_TASK_PREFIX}run:${input.id}:${run.id}`;
        await context.database.userKVStore.update({
            where: { accountId_key: { accountId: owner, key } },
            data: { value: new TextEncoder().encode(JSON.stringify({ ...claim, audit })) },
        });
        now += SCHEDULED_RUN_AUDIT_LIMIT;
        await store.report(owner, input.id, run.id, { claimId: claim.claimId!, status: 'failed', reason: 'configuration-invalid' });
        const [saved] = await store.history(owner, input.id);
        expect(ScheduledRunSchema.parse(saved).audit).toEqual([
            audit[0], ...audit.slice(2), { at: now, status: 'failed', reason: 'configuration-invalid' },
        ]);
    });

    it('reserves one delivery slot and starts the next task deadline only after a later claim', async () => {
        const ids = [input.id, randomUUID()];
        for (const id of ids) { await store.save(owner, { ...input, id, executionKind: 'local-handler' }, -1); await store.runNow(owner, id, randomUUID()); }
        const [first] = await store.claim(owner, machine, 1, 1, 1);
        await store.report(owner, first.taskId, first.id, { claimId: first.claimId!, status: 'running', sequence: 1 });
        now += 10 * 60_000;
        const otherId = ids.find(id => id !== first.taskId)!;
        expect((await store.history(owner, otherId))[0]).toMatchObject({ status: 'pending', deadlineAt: null });
        await store.report(owner, first.taskId, first.id, { claimId: first.claimId!, status: 'completed', sequence: 2 });
        const [second] = await store.claim(owner, machine, 1, 1, 1);
        expect(second.taskId).toBe(otherId); expect(second.deadlineAt).toBeGreaterThan(now);
        now = second.deadlineAt! + 1;
        await expect(store.report(owner, second.taskId, second.id, { claimId: second.claimId!, status: 'running', sequence: 1 })).rejects.toMatchObject({ code: 'start-authorization-expired' });
    });
    it('deletion cancels an accepted pending webhook and revokes credentials and status access', async () => {
        const task = await store.save(owner, input, -1);
        const token = (await store.configureWebhook(owner, task.id, true)).token!;
        const accepted = await store.runNow(owner, task.id, randomUUID(), { token, input: {} });
        const [latest] = await store.list(owner);
        await store.remove(owner, task.id, latest.version);
        const [run] = await store.history(owner, task.id);
        expect(run).toMatchObject({ id: accepted.id, trigger: 'webhook', status: 'cancelled' });
        expect(await store.claim(owner, machine, 1)).toEqual([]);
        await expect(store.webhookOwner(task.id, token)).rejects.toMatchObject({ status: 401 });
        await expect(store.webhookSnapshot(owner, task.id)).rejects.toMatchObject({ status: 401 });
    });
    it('pausing an enabled schedule preserves a previously accepted pending webhook', async () => {
        await store.save(owner, input, -1);
        const token = (await store.configureWebhook(owner, input.id, true)).token!;
        const requestId = randomUUID();
        const issued = { token, input: {} };
        const accepted = await store.runNow(owner, input.id, requestId, issued);
        const [latest] = await store.list(owner);
        const paused = await store.save(owner, { ...input, enabled: false }, latest.version);
        expect(paused).toMatchObject({ enabled: false, nextAt: null, activeRunId: accepted.id });
        expect(await store.webhookStatus(owner, input.id)).toEqual({ enabled: true });
        expect(await store.runNow(owner, input.id, requestId, issued)).toMatchObject({
            id: accepted.id, trigger: 'webhook', status: 'pending', audit: accepted.audit,
        });
        now += 1000;
        expect(await store.due(owner, input.id, now)).toBeNull();
        const [claim] = await store.claim(owner, machine, 1);
        expect(claim).toMatchObject({ id: accepted.id, webhookRequestId: requestId, status: 'claimed', deliveryAuthorized: true });
    });
    it('isolates webhook credentials, rotates and revokes without accepting stale credentials', async () => {
        await store.save(owner, input, -1);
        await expect(store.configureWebhook(other, input.id, true)).rejects.toMatchObject({ code: 'task-not-found' });
        const first = (await store.configureWebhook(owner, input.id, true)).token!;
        expect(await store.webhookOwner(input.id, first)).toBe(owner);
        const second = (await store.configureWebhook(owner, input.id, true)).token!;
        await expect(store.webhookOwner(input.id, first)).rejects.toMatchObject({ status: 401 });
        expect(await store.webhookOwner(input.id, second)).toBe(owner);
        await store.configureWebhook(owner, input.id, false);
        await expect(store.runNow(owner, input.id, randomUUID(), { token: second, input: {} })).rejects.toMatchObject({ status: 401 });
    });
    it('persists independent webhook inputs and rejects busy requests without consuming their identity', async () => {
        await store.save(owner, { ...input, enabled: false }, -1);
        const token = (await store.configureWebhook(owner, input.id, true)).token!;
        const requestId = randomUUID(), secondId = randomUUID();
        const first = await store.runNow(owner, input.id, requestId, { token, input: { value: 'one' } });
        expect((await store.runNow(owner, input.id, requestId, { token, input: { value: 'one' } })).id).toBe(first.id);
        await expect(store.runNow(owner, input.id, requestId, { token, input: { value: 'changed' } })).rejects.toMatchObject({ code: 'idempotency-conflict' });
        await expect(store.runNow(owner, input.id, secondId, { token, input: { value: 'two' } })).rejects.toMatchObject({ code: 'task-busy' });
        const saved = (await store.list(owner))[0];
        await store.save(owner, { ...input, enabled: false, encryptedConfig: 'new-config' }, saved.version);
        expect((await store.history(owner, input.id))[0]).toMatchObject({ status: 'pending', encryptedConfig: 'opaque-ciphertext' });
        const restored = createScheduledTaskStore(context.database, { now: () => now });
        expect(await restored.claim(owner, machine)).toEqual([]);
        const [claim] = await restored.claim(owner, machine, 1);
        expect(claim.webhookInput).toEqual({ value: 'one' });
        expect((await restored.claim(owner, machine, 1))[0].deliveryAuthorized).toBe(false);
        await restored.report(owner, input.id, claim.id, { claimId: claim.claimId!, status: 'uncertain' });
        await expect(restored.runNow(owner, input.id, secondId, { token, input: { value: 'two' } })).rejects.toMatchObject({ code: 'task-busy' });
        await restored.abandon(owner, input.id, claim.id);
        const second = await restored.runNow(owner, input.id, secondId, { token, input: { value: 'two' } });
        expect(second.id).not.toBe(first.id);
        expect(second.webhookInput).toEqual({ value: 'two' });
        expect((await restored.runNow(owner, input.id, requestId, { token, input: { value: 'one' } })).id).toBe(first.id);
        expect(await restored.history(owner, input.id)).toHaveLength(2);
    });
    it('canonicalizes distinct Unicode keys independently of their insertion order', async () => {
        await store.save(owner, input, -1);
        const token = (await store.configureWebhook(owner, input.id, true)).token!;
        const requestId = randomUUID();
        const first = await store.runNow(owner, input.id, requestId, { token, input: { 'é': 1, 'e\u0301': 2 } });
        const retry = await store.runNow(owner, input.id, requestId, { token, input: { 'e\u0301': 2, 'é': 1 } });
        expect(retry.id).toBe(first.id);
    });
    it('serializes concurrent webhook requests and enforces a durable acceptance budget', async () => {
        await store.save(owner, input, -1);
        const token = (await store.configureWebhook(owner, input.id, true)).token!;
        const ids = [randomUUID(), randomUUID()];
        const results = await Promise.allSettled(ids.map(requestId => store.runNow(owner, input.id, requestId, { token, input: { value: requestId } })));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'task-busy' } });
        for (let i = 0; i < 10; i++) {
            if (i > 0) await store.runNow(owner, input.id, randomUUID(), { token, input: { value: i } });
            const [claim] = await store.claim(owner, machine, 1);
            await store.report(owner, input.id, claim.id, { claimId: claim.claimId!, status: 'failed', reason: 'test-terminal' });
        }
        const restored = createScheduledTaskStore(context.database, { now: () => now });
        const id = randomUUID();
        await expect(restored.runNow(owner, input.id, id, { token, input: {} })).rejects.toMatchObject({ code: 'webhook-rate-limit', status: 429 });
        now += 60_001;
        expect((await restored.runNow(owner, input.id, id, { token, input: {} })).status).toBe('pending');
    });
    it('retains webhook receipts beyond ordinary history pruning and bounds total admissions', async () => {
        await store.save(owner, input, -1);
        const token = (await store.configureWebhook(owner, input.id, true)).token!;
        const firstId = randomUUID();
        const first = await store.runNow(owner, input.id, firstId, { token, input: { value: 'keep' } });
        const [claim] = await store.claim(owner, machine, 1);
        await store.report(owner, input.id, claim.id, { claimId: claim.claimId!, status: 'failed', reason: 'test-terminal' });
        const [finished] = await store.history(owner, input.id);
        const encoder = new TextEncoder();
        await context.database.userKVStore.createMany({ data: Array.from({ length: 101 }, (_, i) => {
            const id = randomUUID();
            const ordinary = { ...finished, id, createdAt: now + i + 1, webhookInput: undefined, webhookRequestId: undefined };
            return { accountId: owner, key: `${SCHEDULED_TASK_PREFIX}run:${input.id}:${id}`, value: encoder.encode(JSON.stringify(ordinary)) };
        }) });
        now += 60_001;
        const normal = await store.runNow(owner, input.id, randomUUID());
        const history = await store.history(owner, input.id);
        expect(history.filter(run => run.status === 'failed' && !run.webhookRequestId)).toHaveLength(100);
        expect(history.some(run => run.id === first.id)).toBe(true);
        const [normalClaim] = await store.claim(owner, machine, 1);
        await store.report(owner, input.id, normal.id, { claimId: normalClaim.claimId!, status: 'failed', reason: 'test-terminal' });
        expect((await store.runNow(owner, input.id, firstId, { token, input: { value: 'keep' } })).id).toBe(first.id);
        const prefix = `${SCHEDULED_TASK_PREFIX}webhook-request:${input.id}:`;
        await context.database.userKVStore.createMany({ data: Array.from({ length: 999 }, () => {
            const id = randomUUID();
            return { accountId: owner, key: prefix + id, value: encoder.encode(JSON.stringify({ runId: id, createdAt: now - 60_001 })) };
        }) });
        await expect(store.runNow(owner, input.id, randomUUID(), { token, input: {} })).rejects.toMatchObject({ code: 'webhook-history-limit', status: 429 });
        expect((await store.runNow(owner, input.id, firstId, { token, input: { value: 'keep' } })).id).toBe(first.id);
    });
    it('persists encrypted configuration and materializes a due occurrence only once', async () => {
        await store.save(owner, input, -1);
        expect(await store.due(owner, input.id, now)).toBeNull();
        now += 1000;
        const first = await store.due(owner, input.id, now);
        expect(first).toMatchObject({ status: 'pending', trigger: 'schedule', audit: [{ at: now, status: 'pending', reason: null }] });
        expect(await store.due(owner, input.id, now)).toBeNull();
        expect((await store.history(owner, input.id)).map(run => run.id)).toEqual([first!.id]);
        const restored = createScheduledTaskStore(context.database, { now: () => now });
        expect((await restored.list(owner))[0]).toMatchObject({ encryptedConfig: 'opaque-ciphertext', nextAt: 1_800_003_601_000 });
    });
    it('rejects foreign machines and stale edits without changing the saved plan', async () => {
        await expect(store.save(other, input, -1)).rejects.toMatchObject({ code: 'machine-not-found' });
        const task = await store.save(owner, input, -1);
        await store.save(owner, { ...input, enabled: false }, task.version);
        await expect(store.save(owner, input, task.version)).rejects.toMatchObject({ code: 'version-conflict' });
        expect(await store.list(other)).toEqual([]);
        expect((await store.list(owner))[0].enabled).toBe(false);
    });
    it('coalesces offline occurrences and keeps uncertainty blocking overlap', async () => {
        await store.save(owner, input, -1);
        now += 10_000;
        const run = await store.due(owner, input.id, now);
        now += 3_600_000;
        await store.due(owner, input.id, now);
        expect(await store.history(owner, input.id)).toHaveLength(1);
        const [claim] = await store.claim(owner, machine);
        expect(claim.deliveryAuthorized).toBe(true);
        expect((await store.claim(owner, machine))[0].deliveryAuthorized).toBe(false);
        expect(claim.id).toBe(run!.id);
        expect(claim.missedUntil).toBe(now);
        await store.report(owner, input.id, claim.id, { claimId: claim.claimId!, status: 'uncertain', reason: 'delivery-uncertain' });
        expect((await store.runNow(owner, input.id, randomUUID())).id).toBe(claim.id);
        now += 3_600_000;
        expect(await store.due(owner, input.id, now)).toMatchObject({ status: 'skipped', trigger: 'schedule', audit: [
            { at: now, status: 'pending', reason: null }, { at: now, status: 'skipped', reason: 'previous-run-active' },
        ] });
    });
    it('ties completion to the claimed session and exact root turn', async () => {
        await store.save(owner, input, -1);
        await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        await context.database.session.create({ data: { id: 'scheduled-session-' + owner, accountId: owner, tag: owner, metadata: 'encrypted' } });
        const sessionId = 'scheduled-session-' + owner;
        await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'claimed', sessionId });
        await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'running', sessionId, turnId: 'turn-1' });
        await expect(store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'completed', sessionId, turnId: 'wrong' })).rejects.toMatchObject({ code: 'run-binding-conflict' });
        await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'completed', sessionId, turnId: 'turn-1' });
        const late = await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'running', sessionId, turnId: 'turn-1' });
        expect(late.status).toBe('completed');
        expect((await store.list(owner))[0].activeRunId).toBeNull();
    });
    it('pausing cancels pending delivery and immediate retries reuse the request ID', async () => {
        const task = await store.save(owner, input, -1);
        const id = randomUUID();
        await store.runNow(owner, input.id, id);
        expect((await store.runNow(owner, input.id, id)).id).toBe((await store.history(owner, input.id))[0].id);
        const current = (await store.list(owner))[0];
        await store.save(owner, { ...input, enabled: false }, current.version);
        expect(await store.claim(owner, machine)).toEqual([]);
        expect((await store.history(owner, input.id))[0]).toMatchObject({ status: 'cancelled', trigger: 'manual', audit: [
            { at: now, status: 'pending', reason: null }, { at: now, status: 'cancelled', reason: 'task-paused' },
        ] });
        expect(task.version).toBe(0);
    });
    it('pausing still cancels a pending scheduled occurrence', async () => {
        await store.save(owner, input, -1);
        now += 1000;
        const due = await store.due(owner, input.id, now);
        const [current] = await store.list(owner);
        const paused = await store.save(owner, { ...input, enabled: false }, current.version);
        expect(paused).toMatchObject({ enabled: false, activeRunId: null });
        const [run] = await store.history(owner, input.id);
        expect(run).toMatchObject({ id: due!.id, trigger: 'schedule', status: 'cancelled' });
        expect(run.audit?.at(-1)).toEqual({ at: now, status: 'cancelled', reason: 'task-paused' });
        expect(await store.claim(owner, machine)).toEqual([]);
    });
    it('ends a bound before-ready failure without accepting an unbound or started failure', async () => {
        await store.save(owner, input, -1);
        await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        const sessionId = 'startup-' + owner;
        await context.database.session.create({ data: { id: sessionId, accountId: owner, tag: sessionId, metadata: 'encrypted' } });
        const failure = { claimId: run.claimId!, status: 'failed' as const, reason: 'processor-startup-failed', sessionId, sequence: 1 };
        await expect(store.report(owner, input.id, run.id, failure)).rejects.toMatchObject({ code: 'turn-required' });
        await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'claimed', sessionId });
        await expect(store.report(owner, input.id, run.id, { ...failure, sessionId: undefined })).rejects.toMatchObject({ code: 'turn-required' });
        const stopped = await store.report(owner, input.id, run.id, failure);
        expect(stopped).toMatchObject({ status: 'failed', reason: 'processor-startup-failed', turnId: null, startedAt: null, finishedAt: now, deadlineAt: null });
        expect((await store.list(owner))[0].activeRunId).toBeNull();
        await store.runNow(owner, input.id, randomUUID());
        const [started] = await store.claim(owner, machine);
        await store.report(owner, input.id, started.id, { claimId: started.claimId!, status: 'running', sessionId, turnId: 'root', sequence: 1 });
        await expect(store.report(owner, input.id, started.id, { ...failure, claimId: started.claimId!, sequence: 2, turnId: 'root' })).rejects.toMatchObject({ code: 'turn-required' });
        expect((await store.history(owner, input.id)).find(r => r.id === started.id)?.status).toBe('running');
    });
    it.each([false, true])('releases only the failed dedicated binding and gives the next run a fresh conversation (mode changed=%s)', async modeChanged => {
        input.newChatEachRun = false;
        await store.save(owner, input, -1);
        await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        const sessionId = 'failed-dedicated-' + owner;
        await context.database.session.create({ data: { id: sessionId, accountId: owner, tag: sessionId, metadata: 'encrypted' } });
        await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'claimed', sessionId });
        await store.deliver(owner, input.id, run.id, { claimId: run.claimId!, content: 'failed-input-preserved', expectedSessionSeq: 0 });
        if (modeChanged) await store.save(owner, { ...input, newChatEachRun: true }, (await store.list(owner))[0].version);
        const failure = { claimId: run.claimId!, status: 'failed' as const, reason: 'processor-startup-failed', sessionId, sequence: 1 };
        await store.report(owner, input.id, run.id, failure);
        const recovered = (await store.list(owner))[0];
        expect(recovered).toMatchObject({ activeRunId: null, conversationSessionId: null, bindingVersion: run.bindingVersion + 1 });
        expect((await store.history(owner, input.id))).toHaveLength(1);
        expect((await store.history(owner, input.id))[0]).toMatchObject({ id: run.id, status: 'failed', sessionId });
        expect(await context.database.sessionMessage.count({ where: { sessionId } })).toBe(1);
        if (modeChanged) await store.save(owner, input, recovered.version);
        await store.runNow(owner, input.id, randomUUID());
        const [next] = await store.claim(owner, machine);
        expect(next).toMatchObject({ newChatEachRun: false, conversationSessionId: null, sessionId: null, bindingVersion: run.bindingVersion + 1 });
        expect(next.id).not.toBe(run.id);
        const nextSessionId = 'replacement-' + owner;
        await context.database.session.create({ data: { id: nextSessionId, accountId: owner, tag: nextSessionId, metadata: 'encrypted' } });
        await store.report(owner, input.id, next.id, { claimId: next.claimId!, status: 'claimed', sessionId: nextSessionId });
        await store.report(owner, input.id, run.id, { ...failure, sequence: 2 });
        expect((await store.list(owner))[0]).toMatchObject({ activeRunId: next.id, conversationSessionId: nextSessionId, bindingVersion: next.bindingVersion });
    });
    it.each(['uncertain-bound', 'uncertain-snapshot', 'waiting-for-input'] as const)('detaches the exact dedicated binding when tracking ends: %s', async scenario => {
        input.newChatEachRun = false;
        await store.save(owner, input, -1);
        await store.runNow(owner, input.id, randomUUID());
        const [first] = await store.claim(owner, machine);
        const sessionId = 'abandoned-dedicated-' + owner;
        await context.database.session.create({ data: { id: sessionId, accountId: owner, tag: sessionId, metadata: 'encrypted' } });
        await store.report(owner, input.id, first.id, { claimId: first.claimId!, status: 'running', sessionId, turnId: 'first-root', sequence: 1 });
        await store.report(owner, input.id, first.id, { claimId: first.claimId!, status: 'completed', sessionId, turnId: 'first-root', sequence: 2 });
        await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        expect(run.conversationSessionId).toBe(sessionId);
        if (scenario === 'waiting-for-input') {
            await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'running', sessionId, turnId: 'waiting-root', sequence: 1 });
            await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'waiting-for-input', sessionId, turnId: 'waiting-root', sequence: 2 });
        } else await store.report(owner, input.id, run.id, {
            claimId: run.claimId!, status: 'uncertain', reason: 'session-unavailable',
            ...(scenario === 'uncertain-bound' ? { sessionId } : {}),
        });
        await store.abandon(owner, input.id, run.id);
        expect((await store.list(owner))[0]).toMatchObject({ activeRunId: null, conversationSessionId: null, bindingVersion: run.bindingVersion + 1 });
        const abandoned = (await store.history(owner, input.id)).find(r => r.id === run.id);
        expect(abandoned).toMatchObject({
            status: 'cancelled', reason: 'tracking-ended', conversationSessionId: sessionId,
            sessionId: scenario === 'uncertain-snapshot' ? null : sessionId,
        });
        expect(abandoned?.audit?.at(-1)).toEqual({ at: now, status: 'cancelled', reason: 'tracking-ended' });
        expect(await context.database.session.count({ where: { id: sessionId } })).toBe(1);
        await store.runNow(owner, input.id, randomUUID());
        const [next] = await store.claim(owner, machine);
        expect(next).toMatchObject({ conversationSessionId: null, bindingVersion: run.bindingVersion + 1 });
        await expect(store.abandon(owner, input.id, run.id)).rejects.toMatchObject({ code: 'run-not-blocked' });
        expect((await store.list(owner))[0].activeRunId).toBe(next.id);
    });
    it.each(['startup-failed', 'abandon'].flatMap(operation => ['binding-version', 'conversation', 'active-run', 'per-run'].map(identity => ({ operation, identity }))))('preserves other binding identities during $operation/$identity', async ({ operation, identity }) => {
        input.newChatEachRun = identity === 'per-run';
        await store.save(owner, input, -1);
        await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        const sessionId = 'superseded-' + owner;
        await context.database.session.create({ data: { id: sessionId, accountId: owner, tag: sessionId, metadata: 'encrypted' } });
        await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'claimed', sessionId });
        if (operation === 'abandon') await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'uncertain', sessionId });
        // Seed a superseding task identity in the isolated DB to exercise stale
        // worker receipts; public save intentionally prevents active rebinding.
        const key = SCHEDULED_TASK_PREFIX + 'task:' + input.id;
        const row = await context.database.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: owner, key } } });
        const task = JSON.parse(new TextDecoder().decode(row.value!)) as ScheduledTask;
        const replacement = { ...task, version: row.version + 1, conversationSessionId: sessionId,
            ...(identity === 'binding-version' ? { bindingVersion: task.bindingVersion + 1 } : {}),
            ...(identity === 'conversation' ? { conversationSessionId: 'new-conversation' } : {}),
            ...(identity === 'active-run' ? { activeRunId: randomUUID() } : {}) };
        await context.database.userKVStore.update({ where: { accountId_key: { accountId: owner, key } },
            data: { value: new TextEncoder().encode(JSON.stringify(replacement)), version: { increment: 1 } } });
        if (operation === 'startup-failed') {
            const completion = store.report(owner, input.id, run.id, {
                claimId: run.claimId!, status: 'failed', reason: 'processor-startup-failed', sessionId, sequence: 1,
            });
            if (identity === 'conversation') await expect(completion).rejects.toMatchObject({ code: 'run-binding-conflict' });
            else await completion;
        }
        else await store.abandon(owner, input.id, run.id);
        expect((await store.list(owner))[0]).toMatchObject({
            conversationSessionId: replacement.conversationSessionId, bindingVersion: replacement.bindingVersion,
            activeRunId: identity === 'active-run' || (operation === 'startup-failed' && identity === 'conversation') ? replacement.activeRunId : null,
        });
    });
    it('bounds startup to five minutes and grants the execution window only on the first root start', async () => {
        await store.save(owner, input, -1);
        await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        expect(run.deadlineAt).toBe(now + 5 * 60_000);
        const sessionId = 'deadline-' + owner;
        await context.database.session.create({ data: { id: sessionId, accountId: owner, tag: sessionId, metadata: 'encrypted' } });
        now += 120_000;
        const bound = await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'claimed', sessionId });
        expect(bound.deadlineAt).toBe(run.deadlineAt);
        const running = await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'running', sessionId, turnId: 'root', sequence: 1 });
        expect(running.deadlineAt).toBe(now + 24 * 60 * 60_000);
        const racedDeadline = await store.report(owner, input.id, run.id, {
            claimId: run.claimId!, status: 'uncertain', sessionId, reason: 'startup-deadline-exceeded',
        }, { status: bound.status, updatedAt: bound.updatedAt, deadlineAt: bound.deadlineAt });
        expect(racedDeadline.status).toBe('running');
        expect(racedDeadline.deadlineAt).toBe(running.deadlineAt);
        now += 60_000;
        await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'waiting-for-input', sessionId, turnId: 'root', sequence: 2 });
        const resumed = await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'running', sessionId, turnId: 'root', sequence: 3 });
        expect(resumed.deadlineAt).toBe(running.deadlineAt);
    });
    it('expires a restored legacy startup once without redelivering or releasing overlap protection', async () => {
        await store.save(owner, input, -1);
        await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        const sessionId = 'legacy-startup-' + owner;
        await context.database.session.create({ data: { id: sessionId, accountId: owner, tag: sessionId, metadata: 'encrypted' } });
        const bound = await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'claimed', sessionId });
        now += 5 * 60_000;
        const expired = await store.report(owner, input.id, run.id, {
            claimId: run.claimId!, status: 'uncertain', sessionId, reason: 'startup-deadline-exceeded',
        }, { status: bound.status, updatedAt: bound.updatedAt, deadlineAt: bound.deadlineAt });
        expect(expired).toMatchObject({ status: 'uncertain', reason: 'startup-deadline-exceeded', sessionId, turnId: null });
        expect((await store.claim(owner, machine))[0]).toMatchObject({ id: run.id, deliveryAuthorized: false });
        expect((await store.runNow(owner, input.id, randomUUID())).id).toBe(run.id);
        await store.abandon(owner, input.id, run.id);
        expect((await store.list(owner))[0].activeRunId).toBeNull();
    });
    it('can cancel an offline once-run after its schedule was automatically disabled', async () => {
        input.rule = { type: 'once', at: now + 1000, timezone: 'UTC' };
        await store.save(owner, input, -1);
        now += 1000; await store.due(owner, input.id, now);
        const consumed = (await store.list(owner))[0];
        expect(consumed.enabled).toBe(false);
        await store.save(owner, { ...input, enabled: false }, consumed.version);
        expect((await store.history(owner, input.id))[0].status).toBe('cancelled');
        expect(await store.claim(owner, machine)).toEqual([]);
    });
    it('deleting a running task preserves its receipt without touching another task', async () => {
        await store.save(owner, input, -1);
        const sibling = await store.save(owner, { ...input, id: randomUUID() }, -1);
        await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        await store.remove(owner, input.id, (await store.list(owner)).find(t => t.id === input.id)!.version);
        expect((await store.claim(owner, machine))[0].id).toBe(run.id);
        expect((await store.list(owner)).map(t => t.id)).toEqual([sibling.id]);
    });
    it('deduplicates request IDs that previously returned a busy run', async () => {
        await store.save(owner, input, -1);
        const first = await store.runNow(owner, input.id, randomUUID());
        const secondRequest = randomUUID();
        expect((await store.runNow(owner, input.id, secondRequest)).id).toBe(first.id);
        const [claim] = await store.claim(owner, machine);
        await store.report(owner, input.id, first.id, { claimId: claim.claimId!, status: 'failed', reason: 'configuration-invalid' });
        expect((await store.runNow(owner, input.id, secondRequest)).id).toBe(first.id);
    });
    it('does not broadcast idempotent run-now requests or busy aliases as state changes', async () => {
        await store.save(owner, input, -1);
        const requestId = randomUUID();
        const run = await store.runNow(owner, input.id, requestId);
        const [claim] = await store.claim(owner, machine);
        await store.report(owner, input.id, run.id, { claimId: claim.claimId!, status: 'uncertain', reason: 'delivery-uncertain' });
        let changes = 0; store.onChange(() => { changes++; });
        const alias = randomUUID();
        await store.runNow(owner, input.id, requestId);
        await store.runNow(owner, input.id, alias);
        await store.runNow(owner, input.id, alias);
        expect(changes).toBe(0);
    });
    it('uses distinct run IDs when separate tasks receive the same request ID', async () => {
        await store.save(owner, input, -1);
        const sibling = await store.save(owner, { ...input, id: randomUUID() }, -1);
        const requestId = randomUUID();
        const first = await store.runNow(owner, input.id, requestId);
        const second = await store.runNow(owner, sibling.id, requestId);
        expect(first.id).not.toBe(second.id);
        expect((await store.runNow(owner, sibling.id, requestId)).id).toBe(second.id);
    });
    it('persists a higher receipt sequence even when its semantic state is unchanged', async () => {
        await store.save(owner, input, -1); await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        const sessionId = 'sequence-' + owner;
        await context.database.session.create({ data: { id: sessionId, accountId: owner, tag: sessionId, metadata: 'encrypted' } });
        const running = { claimId: run.claimId!, status: 'running' as const, sessionId, turnId: 'root', sequence: 1 };
        await store.report(owner, input.id, run.id, running);
        let changes = 0; store.onChange(() => { changes++; });
        await store.report(owner, input.id, run.id, { ...running, sequence: 3 });
        const stale = await store.report(owner, input.id, run.id, { ...running, status: 'waiting-for-input', sequence: 2 });
        expect(stale).toMatchObject({ status: 'running', reportSequence: 3 });
        expect(changes).toBe(0);
    });
    it('atomically refuses delivery after tracking ended, and never inserts the prompt twice', async () => {
        await store.save(owner, input, -1); await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        const sessionId = 'delivery-' + owner;
        await context.database.session.create({ data: { id: sessionId, accountId: owner, tag: sessionId, metadata: 'encrypted' } });
        await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'claimed', sessionId });
        await store.deliver(owner, input.id, run.id, { claimId: run.claimId!, content: 'encrypted-prompt', expectedSessionSeq: 0 });
        await store.deliver(owner, input.id, run.id, { claimId: run.claimId!, content: 'encrypted-prompt', expectedSessionSeq: 0 });
        expect(await context.database.sessionMessage.count({ where: { sessionId } })).toBe(1);
        await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'uncertain' });
        await store.abandon(owner, input.id, run.id);
        await expect(store.deliver(owner, input.id, run.id, { claimId: run.claimId!, content: 'different', expectedSessionSeq: 1 })).rejects.toMatchObject({ code: 'delivery-unavailable' });
        expect(await context.database.sessionMessage.count({ where: { sessionId } })).toBe(1);
    });
    it('does not broadcast duplicate receipts or revive timed-out work with an old receipt', async () => {
        await store.save(owner, input, -1); await store.runNow(owner, input.id, randomUUID());
        const [run] = await store.claim(owner, machine);
        const sessionId = 'receipts-' + owner;
        await context.database.session.create({ data: { id: sessionId, accountId: owner, tag: sessionId, metadata: 'encrypted' } });
        const running = { claimId: run.claimId!, status: 'running' as const, sessionId, turnId: 'root', sequence: 1 };
        await store.report(owner, input.id, run.id, running);
        let changes = 0; store.onChange(() => { changes++; });
        await store.report(owner, input.id, run.id, running);
        expect(changes).toBe(0);
        await store.report(owner, input.id, run.id, { claimId: run.claimId!, status: 'uncertain', sessionId, turnId: 'root', reason: 'execution-timeout' });
        expect((await store.report(owner, input.id, run.id, running)).status).toBe('uncertain');
        expect((await store.report(owner, input.id, run.id, { ...running, sequence: 2, status: 'completed' })).status).toBe('completed');
    });
});
