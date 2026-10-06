import { lockServiceAccount, serviceTransaction } from './transactions';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma, AppChatTurn } from '@prisma/client';
import { ExecutionBindingSchema, ServicePrincipalSchema, TurnRecordSchema, TurnActualSchema, ServiceErrorSchema, type ServicePrincipal, type ExecutionBinding, type TurnRecord, type TurnActual, type ServiceError } from '@slopus/happy-wire';
import { verifyServiceIdentity, type AIServiceStore } from './store';
import { authorizeServicePrincipal, targetKey } from './bindings';
import { deny } from './errors';

export function boundTurnRecord(row: AppChatTurn, binding: ExecutionBinding): TurnRecord {
 return TurnRecordSchema.parse({ id: row.id, conversationId: row.conversationId, requestId: row.requestId, binding,
  status: row.state, actual: row.actual ?? { modelId: null, reasoning: null }, createdAt: row.createdAt.getTime(), startedAt: row.startedAt?.getTime() ?? null,
  completedAt: row.completedAt?.getTime() ?? null, error: row.serviceError });
}
export async function authorizeWorkerBinding(tx: Prisma.TransactionClient, ownerId: string, machineId: string, bindingId: string) {
 await lockServiceAccount(tx, ownerId);
 const row = await tx.aIServiceBinding.findFirst({ where: { id: bindingId, ownerId } });
 if (!row?.authorizationId) deny('permission-denied');
 const binding = ExecutionBindingSchema.parse(row.snapshot);
 if ((binding.permissionMode ?? 'chat-only') !== 'chat-only' && !binding.permissions.includes('tools')) deny('permission-denied');
 if (binding.machineId !== machineId) deny('permission-denied');
 const grant = await tx.aIServiceAuthorization.findUnique({ where: { id: row.authorizationId } });
 if (!grant) deny('authorization-revoked');
 const principal = ServicePrincipalSchema.parse({ kind: grant.kind, ownerId, grantId: grant.id, scope: grant.scope });
 const auth = await authorizeServicePrincipal(tx, principal, row.appId, row.serviceId);
 if (principal.kind === 'owner' || !principal.scope.targets.some(target => targetKey(target) === targetKey(binding)) || binding.permissions.some(value => !principal.scope.permissions.includes(value) || !auth.policy.capabilities.includes(value))) deny('permission-denied');
 await tx.$queryRaw`SELECT "id" FROM "AIService" WHERE "id" = ${row.serviceId} AND "ownerId" = ${ownerId} FOR SHARE`;
 const service = await tx.aIService.findFirst({ where: { id: row.serviceId, ownerId, enabled: true, deletedAt: null } });
 if (!service) deny('service-disabled');
 await verifyServiceIdentity(tx, ownerId, binding, row.accountFingerprint, null, true);
 return { binding, grant, principal, fingerprint: row.accountFingerprint };
}
export function createServiceTurns(database: PrismaClient, store: AIServiceStore) {
 const scoped = (principal: ServicePrincipal) => { if (principal.kind === 'owner') deny('permission-denied'); return principal; };
 async function lockTurn(tx: Prisma.TransactionClient, id: string) { await tx.$queryRaw`SELECT "id" FROM "AppChatTurn" WHERE "id" = ${id} FOR UPDATE`; }
 async function expire(tx: Prisma.TransactionClient, machineId: string) {
  await tx.appChatTurn.updateMany({ where: { binding: { snapshot: { path: ['machineId'], equals: machineId } }, state: { in: ['accepted', 'running', 'cancel-requested'] },
   OR: [{ deadline: { lte: new Date() } }, { state: { in: ['running', 'cancel-requested'] }, leaseUntil: { lte: new Date() } }] },
   data: { state: 'interrupted', completedAt: new Date(), lease: null, leaseUntil: null, serviceError: { code: 'execution-interrupted', retryable: false } } });
 }
 return {
  async startBoundTurn(principal: ServicePrincipal, bindingId: string, requestId: string, envelope: { ciphertext: string }): Promise<TurnRecord> {
   const user = scoped(principal);
   if (!requestId || requestId.length > 256 || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length < 60 || Buffer.byteLength(envelope.ciphertext) > 8 * 1024 * 1024) deny('invalid-request');
   // A response-lost retry can read the existing turn without another native discovery.
   const binding = await store.readBinding(user, user.scope.appId, bindingId);
   const existing = await database.appChatTurn.findUnique({ where: { bindingId_requestId: { bindingId, requestId } } });
   if (existing) { if (existing.input !== envelope.ciphertext) deny('invalid-request'); return boundTurnRecord(existing, binding); }
   return store.withValidatedBinding(user, user.scope.appId, bindingId, async (tx, binding) => {
    // Lock the grant's shadow storage row to serialize request deduplication and resource accounting.
    await tx.$queryRaw`SELECT "id" FROM "AppDelegation" WHERE "id" = ${user.grantId} FOR UPDATE`;
    const repeated = await tx.appChatTurn.findUnique({ where: { bindingId_requestId: { bindingId, requestId } } });
    if (repeated) { if (repeated.input !== envelope.ciphertext) deny('invalid-request'); return boundTurnRecord(repeated, binding); }
    await expire(tx, binding.machineId);
    if (!await tx.appChatWorker.findFirst({ where: { machineId: binding.machineId, accountId: user.ownerId, serviceProtocol: 'ai-services/1', activeUntil: { gt: new Date() } } })) deny('machine-offline');
    if (await tx.appChatTurn.count({ where: { conversation: { grantId: user.grantId }, state: { in: ['accepted', 'running', 'cancel-requested'] } } })) deny('resource-busy');
    const storage = await tx.appDelegation.findUniqueOrThrow({ where: { id: user.grantId } });
    const bytes = Buffer.byteLength(envelope.ciphertext);
    if (storage.storedBytes + bytes > 100 * 1024 * 1024) deny('resource-busy');
    await tx.appDelegation.update({ where: { id: user.grantId }, data: { storedBytes: { increment: bytes } } });
    await tx.appChatConversation.upsert({ where: { id: bindingId }, create: { id: bindingId, grantId: user.grantId }, update: {} });
    const row = await tx.appChatTurn.create({ data: { id: randomUUID(), bindingId, conversationId: bindingId, requestId, input: envelope.ciphertext, state: 'accepted', minimumProtocol: 4, deadline: new Date(Date.now()+240000) } });
    return boundTurnRecord(row, binding);
   });
  },
  async readBoundRequest(principal: ServicePrincipal, bindingId: string, requestId: string) {
   const user = scoped(principal), binding = await store.readBinding(user, user.scope.appId, bindingId);
   await database.$transaction(tx => expire(tx,binding.machineId));
   const row = await database.appChatTurn.findUnique({ where: { bindingId_requestId: { bindingId,requestId } } });
   if (!row) deny('invalid-request');
   return { record: boundTurnRecord(row,binding), input: row.input, output: row.output, sequence: row.sequence };
  },
  async readBoundTurn(principal: ServicePrincipal, bindingId: string, id: string) {
   const user = scoped(principal), binding = await store.readBinding(user, user.scope.appId, bindingId);
   await database.$transaction(tx => expire(tx,binding.machineId));
   const row = await database.appChatTurn.findFirst({ where: { id, bindingId } });
   if (!row) deny('permission-denied');
   return { record: boundTurnRecord(row, binding), input: row.input, output: row.output, sequence: row.sequence };
  },
  async readTurns(principal: ServicePrincipal, bindingId: string, cursor?: string) {
   const user = scoped(principal), binding = await store.readBinding(user, user.scope.appId, bindingId);
   await database.$transaction(tx => expire(tx,binding.machineId));
   const anchor = cursor ? await database.appChatTurn.findFirst({ where: { id: cursor, bindingId } }) : null;
   if (cursor && !anchor) deny('invalid-request');
   const rows = await database.appChatTurn.findMany({ where: { bindingId, ...(anchor ? { OR: [{ createdAt: { gt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { gt: anchor.id } }] } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 51 });
   return { turns: rows.slice(0,50).map(row => ({ record: boundTurnRecord(row, binding), input: row.input, output: row.output, sequence: row.sequence })), nextCursor: rows.length > 50 ? rows[49].id : null };
  },
  async cancelBoundTurn(principal: ServicePrincipal, bindingId: string, id: string) {
   const user = scoped(principal);
   await store.readBinding(user, user.scope.appId, bindingId);
   return serviceTransaction(database, user.ownerId, async tx => {
    await authorizeServicePrincipal(tx, user, user.scope.appId, user.scope.serviceId);
    await lockTurn(tx,id);
    const row = await tx.appChatTurn.findFirst({ where: { id, bindingId } });
    if (!row) deny('permission-denied');
    if (row.state === 'accepted') await tx.appChatTurn.update({ where: { id }, data: { state: 'cancelled', completedAt: new Date() } });
    if (row.state === 'running') await tx.appChatTurn.update({ where: { id }, data: { state: 'cancel-requested' } });
    return { cancellationRequested: ['accepted','running','cancel-requested'].includes(row.state), upstreamRetractionGuaranteed: false };
   });
  },
  async claim(ownerId: string, machineId: string) {
   // Expiration takes only turn-row locks; commit it before taking authorization locks.
   await database.$transaction(tx => expire(tx,machineId));
   return serviceTransaction(database, ownerId, async tx => {
    await tx.$queryRaw`SELECT "machineId" FROM "AppChatWorker" WHERE "machineId" = ${machineId} AND "accountId" = ${ownerId} FOR UPDATE`;
    if (!await tx.machine.findFirst({ where: { id: machineId, accountId: ownerId } })) deny('permission-denied');
    if (await tx.appChatTurn.count({ where: { binding: { ownerId, snapshot: { path: ['machineId'], equals: machineId } }, state: { in: ['running','cancel-requested'] } } })) return null;
    const candidates = await tx.appChatTurn.findMany({ where: { binding: { ownerId, snapshot: { path: ['machineId'], equals: machineId } }, state: 'accepted' }, orderBy: { createdAt: 'asc' }, take: 20 });
    for (const row of candidates) {
     let auth;
     try { auth = await authorizeWorkerBinding(tx,ownerId,machineId,row.bindingId!); }
     catch { await tx.appChatTurn.updateMany({ where: { id: row.id, state: 'accepted' }, data: { state: 'interrupted', completedAt: new Date(), serviceError: { code: 'authorization-revoked', retryable: false } } }); continue; }
     // Take the turn lock after authorization, then compare current state and UTC
     // database time. No deadline check occurs before a possible row-lock wait.
     await lockTurn(tx, row.id);
     const lease = randomBytes(32).toString('base64url');
     const [updated] = await tx.$queryRaw<AppChatTurn[]>`UPDATE "AppChatTurn"
      SET "state" = 'running', "startedAt" = (clock_timestamp() AT TIME ZONE 'UTC'), "lease" = ${lease},
          "leaseUntil" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '15 seconds'
      WHERE "id" = ${row.id} AND "state" = 'accepted' AND "deadline" > (clock_timestamp() AT TIME ZONE 'UTC')
      RETURNING *`;
     if (!updated) continue;
     const envelopes = auth.grant.machineEnvelopes as Record<string,string> | null;
     if (!envelopes?.[machineId]) deny('permission-denied');
     return { record: boundTurnRecord(updated,auth.binding), lease, input: row.input, envelope: envelopes[machineId], kind: auth.grant.kind, grantId: auth.grant.id, ownerId, scope: auth.grant.scope };
    }
    return null;
   });
  },
  async publish(ownerId: string, machineId: string, id: string, input: { lease: string; output?: string; sequence?: number; status?: 'completed'|'failed'|'cancelled'; actual?: TurnActual; error?: ServiceError }) {
   return serviceTransaction(database, ownerId, async tx => {
    // Match claim/probe lock order before renewing liveness for this worker.
    await tx.$queryRaw`SELECT "machineId" FROM "AppChatWorker" WHERE "machineId" = ${machineId} AND "accountId" = ${ownerId} FOR UPDATE`;
    const before = await tx.appChatTurn.findUnique({ where: { id } });
    if (!before?.bindingId) deny('permission-denied');
    await authorizeWorkerBinding(tx,ownerId,machineId,before.bindingId);
    await lockTurn(tx,id);
    const row = await tx.appChatTurn.findUniqueOrThrow({ where: { id } });
    if (!['running','cancel-requested'].includes(row.state) || row.lease !== input.lease || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now() || row.deadline.getTime() <= Date.now()) deny('execution-interrupted');
    if (row.state === 'cancel-requested' && input.status !== 'cancelled') deny('execution-interrupted');
    if (input.output && (!input.sequence || input.sequence <= row.sequence || Buffer.byteLength(input.output) > 1024*1024)) deny('invalid-request');
    if (input.status === 'completed' && !input.output && !row.output) deny('invalid-request');
    const actual = input.actual ? TurnActualSchema.parse(input.actual) : undefined;
    const error = input.error ? ServiceErrorSchema.parse(input.error) : undefined;
    if (error && input.status !== 'failed' && input.status !== 'cancelled') deny('invalid-request');
    if (input.status === 'failed' && !error) deny('invalid-request');
    if (input.output) {
     const conversation = await tx.appChatConversation.findUniqueOrThrow({ where: { id: row.conversationId } });
     const grant = await tx.appDelegation.findUniqueOrThrow({ where: { id: conversation.grantId } });
     const growth = Buffer.byteLength(input.output) - Buffer.byteLength(row.output ?? '');
     if (grant.storedBytes + growth > 100*1024*1024) deny('resource-busy');
     await tx.appDelegation.update({ where: { id: grant.id }, data: { storedBytes: { increment: growth } } });
    }
    await tx.appChatTurn.update({ where: { id }, data: { ...(input.output ? { output: input.output, sequence: input.sequence } : {}), ...(actual ? { actual } : {}), ...(error ? { serviceError: error } : {}),
     state: input.status ?? row.state, ...(input.status ? { completedAt: new Date(), lease: null, leaseUntil: null } : { leaseUntil: new Date(Date.now()+15000) }) } });
    // Only an authorized, current lease proves that the worker is still online.
    await tx.appChatWorker.updateMany({ where: { machineId, accountId: ownerId, serviceProtocol: 'ai-services/1' }, data: { activeUntil: new Date(Date.now()+45000) } });
    return { accepted: true };
   });
  },
 };
}
export type ServiceTurns = ReturnType<typeof createServiceTurns>;
