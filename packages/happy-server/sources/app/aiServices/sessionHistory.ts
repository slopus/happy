import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES, ServiceErrorCodeSchema, TurnPhaseSchema, type ServicePrincipal } from '@slopus/happy-wire';
import type { AIServiceStore } from '@/app/aiServices/store';
import { authorizeWorkerBinding } from '@/app/aiServices/turns';
import { lockServiceQuota, serviceTransaction } from '@/app/aiServices/transactions';
import { deny, AIServiceError, AIServicePayloadTooLargeError } from '@/app/aiServices/errors';

/** Broker fresh grant-encrypted history. Each request retains its own response until all live readers have timed out. */
export function createSessionHistory(database: PrismaClient, store: AIServiceStore) {
    return {
        async read(principal: ServicePrincipal, bindingId: string) {
            if (principal.kind === 'owner') deny('permission-denied');
            const binding = await store.readBinding(principal, principal.scope.appId, bindingId);
            const request = await serviceTransaction(database, principal.ownerId, async tx => {
                const auth = await authorizeWorkerBinding(tx, principal.ownerId, binding.machineId, bindingId);
                // This serializes request creation without holding any lock while polling the worker.
                await tx.$queryRaw`SELECT "id" FROM "AIServiceBinding" WHERE "id" = ${bindingId} FOR UPDATE`;
                const row = await tx.aIServiceBinding.findUniqueOrThrow({ where: { id: bindingId } });
                if (!row.sessionId) {
                    const pending = await tx.appChatTurn.findFirst({ where: { bindingId, state: { in: ['accepted', 'running', 'cancel-requested'] } }, orderBy: { createdAt: 'desc' } });
                    return { pending: true as const, active: !!pending, ...(pending ? { phase: TurnPhaseSchema.parse(pending.phase ?? 'connecting') } : {}) };
                }
                if (!await tx.appChatWorker.findFirst({ where: { machineId: binding.machineId, accountId: principal.ownerId, activeUntil: { gt: new Date() }, serviceProtocol: 'ai-services/1' } })) deny('machine-offline');
                // Readers arriving before completion share the request. Completed responses are never overwritten.
                const existing = await tx.aIServiceHistoryRequest.findFirst({ where: { bindingId, state: { in: ['queued', 'running'] }, deadline: { gt: new Date() } }, orderBy: { createdAt: 'asc' } });
                if (existing) return { pending: false as const, ...existing };
                await lockServiceQuota(tx, auth.grant.id);
                if (await tx.aIServiceHistoryRequest.count({ where: { bindingId } }) >= 100) deny('resource-busy');
                const created = await tx.aIServiceHistoryRequest.create({ data: { id: randomUUID(), bindingId, sessionId: row.sessionId, deadline: new Date(Date.now() + 20000) } });
                return { pending: false as const, ...created };
            });
            if (request.pending) return { sessionId: null, requestId: null, ciphertext: null, active: request.active, ...(request.phase ? { phase: request.phase } : {}) };
            while (Date.now() < request.deadline.getTime()) {
                const row = await database.aIServiceHistoryRequest.findUniqueOrThrow({ where: { id: request.id } });
                if (row.state === 'failed') deny(ServiceErrorCodeSchema.safeParse(row.error).data ?? 'execution-interrupted');
                if (row.ciphertext) {
                    await store.readBinding(principal, principal.scope.appId, bindingId);
                    return { sessionId: request.sessionId, requestId: request.id, ciphertext: row.ciphertext };
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return deny('execution-interrupted');
        },
        async claim(ownerId: string, machineId: string) {
            return serviceTransaction(database, ownerId, async tx => {
                if (!await tx.machine.findFirst({ where: { id: machineId, accountId: ownerId } })) deny('permission-denied');
                const rows = await tx.aIServiceHistoryRequest.findMany({ where: { binding: { ownerId, snapshot: { path: ['machineId'], equals: machineId } }, state: 'queued', deadline: { gt: new Date() } }, orderBy: { createdAt: 'asc' }, take: 100 });
                for (const row of rows) {
                    try {
                        const auth = await authorizeWorkerBinding(tx, ownerId, machineId, row.bindingId);
                        const envelopes = auth.grant.machineEnvelopes as Record<string, string> | null;
                        if (!envelopes?.[machineId]) deny('permission-denied');
                        const claimed = await tx.aIServiceHistoryRequest.updateMany({ where: { id: row.id, state: 'queued', deadline: { gt: new Date() } }, data: { state: 'running' } });
                        if (!claimed.count) continue;
                        return { id: row.bindingId, sessionId: row.sessionId, requestId: row.id, binding: auth.binding, grantId: auth.grant.id, ownerId, scope: auth.grant.scope, kind: auth.grant.kind, envelope: envelopes[machineId] };
                    } catch (error) {
                        if (!(error instanceof AIServiceError)) throw error;
                        await tx.aIServiceHistoryRequest.updateMany({ where: { id: row.id, state: 'queued' }, data: { state: 'failed', error: error.code } });
                    }
                }
                return null;
            });
        },
        async publish(ownerId: string, machineId: string, bindingId: string, input: { requestId: string; sessionId: string; ciphertext: string }) {
            if (input.ciphertext.length < 60) deny('invalid-request');
            if (Buffer.byteLength(input.ciphertext) > NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES) throw new AIServicePayloadTooLargeError();
            return serviceTransaction(database, ownerId, async tx => {
                const auth = await authorizeWorkerBinding(tx, ownerId, machineId, bindingId);
                // Same grant lock used by turn admission/output prevents separate bindings exceeding their shared budget.
                await lockServiceQuota(tx, auth.grant.id);
                const storage = await tx.appDelegation.findUniqueOrThrow({ where: { id: auth.grant.id } });
                const bytes = Buffer.byteLength(input.ciphertext);
                if (storage.storedBytes + bytes > 100 * 1024 * 1024) deny('resource-busy');
                const updated = await tx.aIServiceHistoryRequest.updateMany({ where: { id: input.requestId, bindingId, sessionId: input.sessionId, deadline: { gt: new Date() }, state: 'running' }, data: { state: 'completed', ciphertext: input.ciphertext } });
                if (!updated.count) deny('execution-interrupted');
                await tx.appDelegation.update({ where: { id: auth.grant.id }, data: { storedBytes: { increment: bytes } } });
                return { accepted: true };
            });
        },
    };
}
