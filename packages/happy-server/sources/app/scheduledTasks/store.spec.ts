import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@/app/aiServices/testDatabase';
import { createScheduledTaskStore } from './store';
import type { ScheduledTaskInput } from '@slopus/happy-wire';

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

    it('persists encrypted configuration and materializes a due occurrence only once', async () => {
        await store.save(owner, input, -1);
        expect(await store.due(owner, input.id, now)).toBeNull();
        now += 1000;
        const first = await store.due(owner, input.id, now);
        expect(first?.status).toBe('pending');
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
        expect((await store.due(owner, input.id, now))?.status).toBe('skipped');
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
        expect((await store.history(owner, input.id))[0].status).toBe('cancelled');
        expect(task.version).toBe(0);
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
