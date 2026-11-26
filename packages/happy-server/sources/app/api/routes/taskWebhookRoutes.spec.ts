import fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { createTestDatabase } from '@/app/aiServices/testDatabase';
import { createScheduledTaskStore } from '@/app/scheduledTasks/store';
import type { Fastify } from '@/app/api/types';
vi.mock('@/app/scheduledTasks/service', () => ({ scheduledTaskStore: {}, recoverScheduledTaskDeadlines() {} }));
import { scheduledTaskRoutes } from './scheduledTaskRoutes';

let context: Awaited<ReturnType<typeof createTestDatabase>>;
const app = fastify();
let origin: string, owner: string, taskId: string, token: string;
let store: ReturnType<typeof createScheduledTaskStore>;
beforeAll(async () => {
    context = await createTestDatabase();
    owner = randomUUID(); taskId = randomUUID(); const machine = randomUUID();
    await context.database.account.create({ data: { id: owner, publicKey: owner } });
    await context.database.machine.create({ data: { id: machine, accountId: owner, metadata: 'ciphertext' } });
    store = createScheduledTaskStore(context.database);
    await store.save(owner, { id: taskId, machineId: machine, enabled: false, rule: { type: 'interval', anchor: Date.now(), hours: 1, timezone: 'UTC' }, encryptedConfig: 'ciphertext', newChatEachRun: true, notificationPolicy: 'none' }, -1);
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: any, reply: any) => {
        if (request.headers.authorization !== 'Bearer owner-test-credential') return reply.code(401).send({});
        request.userId = owner;
    });
    scheduledTaskRoutes(app as unknown as Fastify, store);
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
}, 120000);
afterAll(async () => { await app.close(); await context.database.$disconnect(); await context.pg.close(); });
it('streams only task metadata with a scoped credential and closes immediately on rotation', async () => {
    const credential = (await store.configureWebhook(owner, taskId, true)).token!;
    expect((await fetch(`${origin}/v1/task-webhooks/${taskId}/events`, { headers: { authorization: 'Bearer owner-test-credential' } })).status).toBe(401);
    expect((await fetch(`${origin}/v1/task-webhooks/${randomUUID()}/events`, { headers: { authorization: `Bearer ${credential}` } })).status).toBe(401);
    const cancel = new AbortController();
    try {
        const stream = await fetch(`${origin}/v1/task-webhooks/${taskId}/events`, { headers: { authorization: `Bearer ${credential}` }, signal: cancel.signal });
        expect(stream.status).toBe(200);
        const reader = stream.body!.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        expect(first).toContain('event: state');
        expect(first).toContain('"activeRunId":null');
        expect(first).not.toMatch(/ciphertext|encryptedConfig|machineId|prompt/);
        await store.configureWebhook(owner, taskId, true);
        expect((await reader.read()).done).toBe(true);
        expect((await fetch(`${origin}/v1/task-webhooks/${taskId}/events`, { headers: { authorization: `Bearer ${credential}` } })).status).toBe(401);
    } finally { cancel.abort(); }
});
it('serves real HTTP with task-scoped authentication, validation, deduplication and explicit backpressure', async () => {
    const configure = await fetch(`${origin}/v1/scheduled-tasks/${taskId}/webhook`, { method: 'POST', headers: { authorization: 'Bearer owner-test-credential', 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    expect(configure.headers.get('cache-control')).toBe('no-store');
    token = (await configure.json() as { token: string }).token;
    const call = (payload: unknown, credential = token) => fetch(`${origin}/v1/task-webhooks/${taskId}`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const requestId = randomUUID(); const payload = { requestId, input: { value: 'one' } };
    expect((await call(payload, 'wrong')).status).toBe(401);
    const foreign = await fetch(`${origin}/v1/task-webhooks/${randomUUID()}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(foreign.status).toBe(401);
    expect((await call(payload, 'owner-test-credential')).status).toBe(401);
    expect((await call({ ...payload, directory: '/tmp' })).status).toBe(400);
    expect((await call({ ...payload, input: { nested: {} } })).status).toBe(400);
    expect((await call({ ...payload, input: { value: 'x'.repeat(20000) } })).status).toBe(413);
    const first = await call(payload); expect(first.status).toBe(202);
    const accepted = await first.json();
    expect(await (await call(payload)).json()).toEqual(accepted);
    expect((await call({ requestId, input: { value: 'changed' } })).status).toBe(409);
    const second = { requestId: randomUUID(), input: { value: 'two' } };
    expect((await call(second)).status).toBe(409);
    const machine = (await store.list(owner))[0].machineId;
    const [claim] = await store.claim(owner, machine, 1);
    await store.report(owner, taskId, claim.id, { claimId: claim.claimId!, status: 'failed', reason: 'test-execution-failed' });
    expect((await call(second)).status).toBe(202);
    expect((await store.history(owner, taskId)).map(r => r.webhookInput?.value).sort()).toEqual(['one', 'two']);
    await store.configureWebhook(owner, taskId, false);
    expect((await call(payload)).status).toBe(401);
    const attempts = await Promise.all(Array.from({ length: 60 }, () => call(payload, 'invalid')));
    expect(attempts.some(r => r.status === 429 && r.headers.get('retry-after') === '60')).toBe(true);
    expect((await call(payload)).status).toBe(429);
});
it('closes only the affected streams on disable and delete', async () => {
    const template = (await store.list(owner))[0];
    const open = async (id: string, credential: string) => {
        const response = await fetch(`${origin}/v1/task-webhooks/${id}/events`, { headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(10000) });
        expect(response.status).toBe(200); const reader = response.body!.getReader(); await reader.read(); return reader;
    };
    for (const operation of ['disable', 'delete']) {
        const task = await store.save(owner, { ...template, id: randomUUID() }, -1);
        const sibling = await store.save(owner, { ...template, id: randomUUID() }, -1);
        const token = (await store.configureWebhook(owner, task.id, true)).token!;
        const otherToken = (await store.configureWebhook(owner, sibling.id, true)).token!;
        const reader = await open(task.id, token), otherReader = await open(sibling.id, otherToken);
        try {
            if (operation === 'delete') await store.remove(owner, task.id, task.version);
            else await store.configureWebhook(owner, task.id, false);
            expect((await reader.read()).done).toBe(true);
            expect((await fetch(`${origin}/v1/task-webhooks/${task.id}/events`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
            await store.runNow(owner, sibling.id, randomUUID(), { token: otherToken, input: { marker: 'other-task' } });
            expect((await otherReader.read()).done).toBe(false);
        } finally { await reader.cancel(); await otherReader.cancel(); }
    }
});
