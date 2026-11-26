/** Authenticated scheduling API; ciphertext is opaque and every operation is account-scoped. */
import { z } from 'zod';
import { TaskWebhookInputSchema, ScheduledTaskInputSchema, ScheduledRunReportSchema } from '@slopus/happy-wire';
import type { Fastify } from '@/app/api/types';
import { ScheduledTaskError } from '@/app/scheduledTasks/store';
import { scheduledTaskStore as store, recoverScheduledTaskDeadlines } from '@/app/scheduledTasks/service';

const taskParams = z.object({ taskId: z.string().uuid() });
const runParams = taskParams.extend({ runId: z.string().uuid() });
const webhookCredential = (authorization?: string) => authorization?.match(/^Bearer ([A-Za-z0-9_-]{2,267}\.[A-Za-z0-9_-]{43})$/)?.[1] ?? '';
export function scheduledTaskRoutes(app: Fastify, taskStore = store): void {
    const store = taskStore;
    // Bounded, process-local ingress budget includes invalid credentials and replays.
    // Lazy expiry needs no periodic job; the durable acceptance budget lives in the store.
    const attempts = new Map<string, { start: number; count: number }>();
    const streams = new Map<string, number>();
    app.register(async api => {
        const routes = api.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();
        routes.setErrorHandler((error, _request, reply) => {
            if (error instanceof ScheduledTaskError) return reply.code(error.status).send({ error: error.code });
            if ((error && typeof error === 'object' && 'validation' in error) || error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-scheduled-task' });
            throw error;
        });
        routes.get('/v1/scheduled-tasks/:taskId/webhook', { preHandler: app.authenticate, schema: { params: taskParams } },
            async request => store.webhookStatus(request.userId, request.params.taskId));
        routes.post('/v1/scheduled-tasks/:taskId/webhook', { preHandler: app.authenticate, schema: {
            params: taskParams, body: z.object({ enabled: z.boolean() }).strict(),
        } }, async (request, reply) => {
            reply.header('Cache-Control', 'no-store');
            return store.configureWebhook(request.userId, request.params.taskId, request.body.enabled);
        });
        routes.post('/v1/task-webhooks/:taskId', { bodyLimit: 16384, onRequest: async (request, reply) => {
            const now = Date.now();
            let budget = attempts.get(request.ip);
            if (!budget || now - budget.start >= 60_000) {
                attempts.delete(request.ip);
                if (attempts.size >= 1024) attempts.delete(attempts.keys().next().value!);
                budget = { start: now, count: 0 }; attempts.set(request.ip, budget);
            }
            if (++budget.count > 60) return reply.header('Retry-After', '60').code(429).send({ error: 'webhook-ingress-limit' });
        }, schema: {
            params: taskParams, body: z.object({ requestId: z.string().uuid(), input: TaskWebhookInputSchema }).strict(),
        } }, async (request, reply) => {
            const token = webhookCredential(request.headers.authorization);
            const accountId = await store.webhookOwner(request.params.taskId, token);
            const run = await store.runNow(accountId, request.params.taskId, request.body.requestId, { token, input: request.body.input });
            reply.header('Cache-Control', 'no-store');
            return reply.code(202).send({ requestId: request.body.requestId, runId: run.id, status: run.status });
        });
        // Same task-scoped credential; no account token, ciphertext, prompt, input,
        // session content or machine information is exposed. One server process
        // owns scheduling today; use a shared event bus before horizontal scaling.
        routes.get('/v1/task-webhooks/:taskId/events', { schema: { params: taskParams } }, async (request, reply) => {
            const taskId = request.params.taskId, token = webhookCredential(request.headers.authorization);
            const accountId = await store.webhookOwner(taskId, token);
            const scope = `${accountId}:${taskId}`;
            if ((streams.get(scope) ?? 0) >= 5 || streams.size >= 256) return reply.code(429).send({ error: 'webhook-stream-limit' });
            streams.set(scope, (streams.get(scope) ?? 0) + 1);
            reply.hijack();
            reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
            let closed = false, sending = false, dirty = false;
            const send = async () => {
                dirty = true;
                if (sending || closed) return;
                sending = true;
                try {
                    do {
                        dirty = false;
                        await store.webhookOwner(taskId, token);
                        const snapshot = await store.webhookSnapshot(accountId, taskId);
                        // A revoke/delete may have committed during the snapshot reads.
                        await store.webhookOwner(taskId, token);
                        if (closed) return;
                        if (dirty) continue;
                        if (reply.raw.writableLength > 1_000_000) { reply.raw.end(); return; }
                        reply.raw.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`);
                    } while (dirty && !closed);
                } catch { reply.raw.end(); }
                finally { sending = false; }
            };
            const unsubscribe = store.onChange(change => { if (change.accountId === accountId && change.task.id === taskId) void send(); });
            reply.raw.once('close', () => {
                closed = true; unsubscribe();
                const count = (streams.get(scope) ?? 1) - 1;
                if (count) streams.set(scope, count); else streams.delete(scope);
            });
            await send();
        });
        routes.get('/v1/scheduled-tasks', { preHandler: app.authenticate }, async request => {
            recoverScheduledTaskDeadlines(request.userId);
            return { protocol: 1, tasks: await store.list(request.userId) };
        });
        routes.put('/v1/scheduled-tasks/:taskId', { preHandler: app.authenticate, schema: {
            params: taskParams, body: ScheduledTaskInputSchema.extend({ expectedVersion: z.number().int().min(-1), resetBinding: z.boolean().optional() }).strict(),
        } }, async (request, reply) => {
            const { expectedVersion, resetBinding, ...input } = request.body;
            if (input.id !== request.params.taskId) return reply.code(400).send({ error: 'task-id-mismatch' });
            return { task: await store.save(request.userId, input, expectedVersion, resetBinding) };
        });
        routes.delete('/v1/scheduled-tasks/:taskId', { preHandler: app.authenticate, schema: {
            params: taskParams, body: z.object({ expectedVersion: z.number().int().min(0) }).strict(),
        } }, async request => { await store.remove(request.userId, request.params.taskId, request.body.expectedVersion); return { success: true }; });
        routes.get('/v1/scheduled-tasks/:taskId/runs', { preHandler: app.authenticate, schema: { params: taskParams } },
            async request => ({ runs: await store.history(request.userId, request.params.taskId) }));
        routes.post('/v1/scheduled-tasks/:taskId/run', { preHandler: app.authenticate, schema: {
            params: taskParams, body: z.object({ requestId: z.string().uuid() }).strict(),
        } }, async request => ({ run: await store.runNow(request.userId, request.params.taskId, request.body.requestId) }));
        routes.post('/v1/scheduled-tasks/machines/:machineId/claim', { preHandler: app.authenticate, schema: {
            params: z.object({ machineId: z.string().min(1).max(200) }),
            body: z.object({ taskWebhookProtocol: z.literal(1).optional(), localHandlerProtocol: z.literal(1).optional(), maxNewClaims: z.number().int().min(1).max(20).optional() }).strict().optional(),
        } }, async request => ({ runs: await store.claim(request.userId, request.params.machineId, request.body?.taskWebhookProtocol, request.body?.localHandlerProtocol, request.body?.maxNewClaims) }));
        routes.post('/v1/scheduled-tasks/:taskId/runs/:runId/report', { preHandler: app.authenticate, schema: {
            params: runParams, body: ScheduledRunReportSchema,
        } }, async request => ({ run: await store.report(request.userId, request.params.taskId, request.params.runId, request.body) }));
        routes.post('/v1/scheduled-tasks/:taskId/runs/:runId/deliver', { preHandler: app.authenticate, schema: {
            params: runParams, body: z.object({ claimId: z.string().uuid(), content: z.string().min(1).max(400000), expectedSessionSeq: z.number().int().nonnegative() }).strict(),
        } }, async request => { await store.deliver(request.userId, request.params.taskId, request.params.runId, request.body); return { success: true }; });
        routes.post('/v1/scheduled-tasks/:taskId/runs/:runId/abandon', { preHandler: app.authenticate, schema: { params: runParams } },
            async request => { await store.abandon(request.userId, request.params.taskId, request.params.runId); return { success: true }; });
    });
}
