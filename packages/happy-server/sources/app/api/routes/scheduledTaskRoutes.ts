/** Authenticated scheduling API; ciphertext is opaque and every operation is account-scoped. */
import { z } from 'zod';
import { ScheduledTaskInputSchema, ScheduledRunReportSchema } from '@slopus/happy-wire';
import type { Fastify } from '@/app/api/types';
import { ScheduledTaskError } from '@/app/scheduledTasks/store';
import { scheduledTaskStore as store, recoverScheduledTaskDeadlines } from '@/app/scheduledTasks/service';

const taskParams = z.object({ taskId: z.string().uuid() });
const runParams = taskParams.extend({ runId: z.string().uuid() });
export function scheduledTaskRoutes(app: Fastify): void {
    app.register(async api => {
        const routes = api.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();
        routes.setErrorHandler((error, _request, reply) => {
            if (error instanceof ScheduledTaskError) return reply.code(error.status).send({ error: error.code });
            if ((error && typeof error === 'object' && 'validation' in error) || error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-scheduled-task' });
            throw error;
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
        } }, async request => ({ runs: await store.claim(request.userId, request.params.machineId) }));
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
