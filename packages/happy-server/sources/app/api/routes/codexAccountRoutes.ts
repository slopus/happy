import type { Fastify } from '../types';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CodexAccountError, codexAccountStore } from './codexAccountStore';
import {
    CODEX_AUTH_MAX_BYTES, uploadCodexAccountSchema, renameCodexAccountSchema, bindCodexAccountSchema,
    createCodexGrantSchema, redeemCodexGrantSchema, registerCodexSessionSchema, updateCodexCredentialSchema, reportCodexQuotaSchema, reportCodexQuotaProbeSchema, reportCodexStatusSchema,
} from './codexAccountTypes';

export * from './codexAccountTypes';

// Parse inside the guarded handler so validation errors never reach the global
// error logger (Zod / Prisma errors can contain credential values).
async function guarded(reply: FastifyReply, operation: () => Promise<unknown>) {
    reply.header('Cache-Control', 'no-store');
    try { return reply.send(await operation()); }
    catch (error) {
        if (error instanceof CodexAccountError) return reply.code(error.status).send({ error: error.code });
        if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid-request' });
        return reply.code(500).send({ error: 'codex-account-operation-failed' });
    }
}
const profileId = z.string().uuid();
const machineId = z.string().min(1).max(256);

export function codexAccountRoutes(app: Fastify): void {
    const options = { preHandler: app.authenticate, bodyLimit: CODEX_AUTH_MAX_BYTES };
    app.get('/v1/codex-accounts', options, (req, reply) => guarded(reply, () => codexAccountStore.list(req.userId)));
    app.post('/v1/codex-accounts/upload', options, (req, reply) => guarded(reply, () => codexAccountStore.upload(req.userId, uploadCodexAccountSchema.parse(req.body).auth)));
    app.patch<{ Params: { id: string } }>('/v1/codex-accounts/:id', options, (req, reply) => guarded(reply, () => codexAccountStore.rename(req.userId, profileId.parse(req.params.id), renameCodexAccountSchema.parse(req.body).displayName)));
    app.delete<{ Params: { id: string } }>('/v1/codex-accounts/:id', options, (req, reply) => guarded(reply, () => codexAccountStore.delete(req.userId, profileId.parse(req.params.id))));
    app.put<{ Params: { machineId: string } }>('/v1/machines/:machineId/codex-account', options, (req, reply) => guarded(reply, () => codexAccountStore.bind(req.userId, machineId.parse(req.params.machineId), bindCodexAccountSchema.parse(req.body))));
    app.post('/v1/codex-session-grants', options, (req, reply) => guarded(reply, () => {
        const input = createCodexGrantSchema.parse(req.body);
        return codexAccountStore.createGrant(req.userId, input.machineId, input.sourceSessionId);
    }));
    app.post('/v1/codex-session-grants/redeem', options, (req, reply) => guarded(reply, () => {
        const input = redeemCodexGrantSchema.parse(req.body);
        return codexAccountStore.redeem(req.userId, input.machineId, input.grant);
    }));
    app.post<{ Params: { id: string } }>('/v1/codex-session-grants/:id/session', options, (req, reply) => guarded(reply, () => {
        const input = registerCodexSessionSchema.parse(req.body);
        return codexAccountStore.registerSession(req.userId, profileId.parse(req.params.id), input.machineId, input.sourceSessionId);
    }));
    app.put<{ Params: { id: string } }>('/v1/codex-accounts/:id/credential', options, (req, reply) => guarded(reply, () => codexAccountStore.updateCredential(req.userId, profileId.parse(req.params.id), updateCodexCredentialSchema.parse(req.body))));
    app.put<{ Params: { id: string } }>('/v1/codex-accounts/:id/quota-snapshot', options, (req, reply) => guarded(reply, () => codexAccountStore.reportQuota(req.userId, profileId.parse(req.params.id), reportCodexQuotaSchema.parse(req.body))));
    app.put<{ Params: { id: string } }>('/v1/codex-accounts/:id/quota-probe', options, (req, reply) => guarded(reply, () => codexAccountStore.reportQuotaProbe(req.userId, profileId.parse(req.params.id), reportCodexQuotaProbeSchema.parse(req.body))));
    app.put<{ Params: { id: string } }>('/v1/codex-accounts/:id/status', options, (req, reply) => guarded(reply, () => codexAccountStore.reportStatus(req.userId, profileId.parse(req.params.id), reportCodexStatusSchema.parse(req.body))));
}
