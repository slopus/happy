import { lockServiceAccount, lockServiceQuota, serviceTransaction } from './transactions';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma, AppChatTurn } from '@prisma/client';
import { NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES, ExecutionBindingSchema, ServicePrincipalSchema, TurnRecordSchema, TurnActualSchema, ServiceErrorSchema, type ServicePrincipal, type ExecutionBinding, type TurnRecord, type TurnActual, type ServiceError, type TurnPhase, TurnPhaseSchema } from '@slopus/happy-wire';
import { verifyServiceIdentity, type AIServiceStore } from './store';
import { authorizeServicePrincipal, targetKey } from './bindings';
import { deny, AIServicePayloadTooLargeError } from './errors';

export function boundTurnRecord(row: AppChatTurn, binding: ExecutionBinding): TurnRecord {
 return TurnRecordSchema.parse({ id: row.id, conversationId: row.conversationId, requestId: row.requestId, binding,
  ...(row.sessionId ? { sessionId: row.sessionId } : {}), ...(row.phase ? { phase: row.phase } : {}),
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
 return { binding, grant, principal, fingerprint: row.accountFingerprint, sessionId: row.sessionId };
}
export function createServiceTurns(database: PrismaClient, store: AIServiceStore) {
 const scoped = (principal: ServicePrincipal) => { if (principal.kind === 'owner') deny('permission-denied'); return principal; };
 async function lockTurn(tx: Prisma.TransactionClient, id: string) { await tx.$queryRaw`SELECT "id" FROM "AppChatTurn" WHERE "id" = ${id} FOR UPDATE`; }
 async function expire(tx: Prisma.TransactionClient, machineId: string) {
  // A pre-upgrade accepted service turn cannot run through the native executor. Retain it with an explicit outcome.
  await tx.appChatTurn.updateMany({where:{minimumProtocol:4,state:'accepted',binding:{snapshot:{path:['machineId'],equals:machineId}}},data:{state:'interrupted',completedAt:new Date(),lease:null,leaseUntil:null,serviceError:{code:'protocol-incompatible',retryable:false}}});
  // Unknown native execution is reconciled under the SAME turn/localId, never made retryable as a new request.
  for (const state of ['running','accepted','cancel-requested']) await tx.appChatTurn.updateMany({where:{minimumProtocol:5,binding:{snapshot:{path:['machineId'],equals:machineId}},state,
   OR:[{deadline:{lte:new Date()}},...(state==='accepted'?[]:[{leaseUntil:{lte:new Date()}}])]},data:{state:state==='cancel-requested'?'cancel-requested':'accepted',phase:'recovering',lease:null,leaseUntil:null,deadline:new Date(Date.now()+240000)}});

  await tx.appChatTurn.updateMany({ where: { minimumProtocol: { lt: 5 }, binding: { snapshot: { path: ['machineId'], equals: machineId } }, state: { in: ['accepted', 'running', 'cancel-requested'] },
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
    await lockServiceQuota(tx, user.grantId);
    const repeated = await tx.appChatTurn.findUnique({ where: { bindingId_requestId: { bindingId, requestId } } });
    if (repeated) { if (repeated.input !== envelope.ciphertext) deny('invalid-request'); return boundTurnRecord(repeated, binding); }
    const mapped = await tx.aIServiceBinding.findUniqueOrThrow({where:{id:bindingId}});
    if (!mapped.sessionId && await tx.appChatTurn.count({where:{bindingId,minimumProtocol:{lt:5}}})) deny('protocol-incompatible');
    await expire(tx, binding.machineId);
    if (!await tx.appChatWorker.findFirst({ where: { machineId: binding.machineId, accountId: user.ownerId, serviceProtocol: 'ai-services/1', activeUntil: { gt: new Date() } } })) deny('machine-offline');
    if (!await tx.appChatWorker.findFirst({where:{machineId:binding.machineId,accountId:user.ownerId,nativeSessions:true}})) deny('protocol-incompatible');
    if (await tx.appChatTurn.count({ where: { conversation: { grantId: user.grantId }, state: { in: ['accepted', 'running', 'cancel-requested'] } } })) deny('resource-busy');
    const storage = await tx.appDelegation.findUniqueOrThrow({ where: { id: user.grantId } });
    const bytes = Buffer.byteLength(envelope.ciphertext);
    if (storage.storedBytes + bytes > 100 * 1024 * 1024) deny('resource-busy');
    await tx.appDelegation.update({ where: { id: user.grantId }, data: { storedBytes: { increment: bytes } } });
    await tx.appChatConversation.upsert({ where: { id: bindingId }, create: { id: bindingId, grantId: user.grantId }, update: {} });
    const row = await tx.appChatTurn.create({ data: { id: randomUUID(), bindingId, conversationId: bindingId, requestId, input: envelope.ciphertext, state: 'accepted', sessionId: mapped.sessionId, minimumProtocol: 5, deadline: new Date(Date.now()+240000) } });
    return boundTurnRecord(row, binding);
   // Codex bindings have immutable, validated execution options. Recheck live
   // authorization/identity and worker liveness, then submit directly. A separate
   // model/list process on every message adds latency without proving entitlement
   // to the subsequent turn; the native provider still rejects unavailable models.
   // Claude's device-local identity continues to require live observation.
   }, binding.engine !== 'codex');
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
    if (row.state === 'accepted' && !(row.minimumProtocol === 5 && row.startedAt)) await tx.appChatTurn.update({ where: { id }, data: { state: 'cancelled', completedAt: new Date() } });
    if (row.state === 'running' || row.state === 'accepted' && row.minimumProtocol === 5 && row.startedAt) await tx.appChatTurn.update({ where: { id }, data: { state: 'cancel-requested' } });
    return { cancellationRequested: ['accepted','running','cancel-requested'].includes(row.state), upstreamRetractionGuaranteed: false };
   });
  },
  async claim(ownerId: string, machineId: string) {
   if (!await database.machine.findFirst({where:{id:machineId,accountId:ownerId}})) deny('permission-denied');
   // Expiration takes only turn-row locks; commit it before taking authorization locks.
   await database.$transaction(tx => expire(tx,machineId));
   return serviceTransaction(database, ownerId, async tx => {
    await tx.$queryRaw`SELECT "machineId" FROM "AppChatWorker" WHERE "machineId" = ${machineId} AND "accountId" = ${ownerId} FOR UPDATE`;
    if (!await tx.machine.findFirst({ where: { id: machineId, accountId: ownerId } })) deny('permission-denied');
    if (!await tx.appChatWorker.findFirst({where:{machineId,accountId:ownerId,nativeSessions:true}})) return null;
    if (await tx.appChatTurn.count({ where: { binding: { ownerId, snapshot: { path: ['machineId'], equals: machineId } }, state: { in: ['running','cancel-requested'] }, lease: {not:null} } })) return null;
    const candidates = await tx.appChatTurn.findMany({ where: { binding: { ownerId, snapshot: { path: ['machineId'], equals: machineId } }, minimumProtocol:5, OR:[{state:'accepted'},{state:'cancel-requested',lease:null}] }, orderBy: { createdAt: 'asc' }, take: 20 });
    for (const row of candidates) {
     let auth;
     try { auth = await authorizeWorkerBinding(tx,ownerId,machineId,row.bindingId!); }
     catch { await tx.appChatTurn.updateMany({ where: { id: row.id, state: {in:['accepted','cancel-requested']} }, data: { state: 'interrupted', completedAt: new Date(), serviceError: { code: 'authorization-revoked', retryable: false } } }); continue; }
     // Take the turn lock after authorization, then compare current state and UTC
     // database time. No deadline check occurs before a possible row-lock wait.
     await lockTurn(tx, row.id);
     const lease = randomBytes(32).toString('base64url');
     const [updated] = await tx.$queryRaw<AppChatTurn[]>`UPDATE "AppChatTurn"
      SET "state" = CASE WHEN "state" = 'cancel-requested' THEN 'cancel-requested' ELSE 'running' END, "startedAt" = COALESCE("startedAt", (clock_timestamp() AT TIME ZONE 'UTC')), "lease" = ${lease},
          "leaseUntil" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '15 seconds'
      WHERE "id" = ${row.id} AND ("state" = 'accepted' OR ("state" = 'cancel-requested' AND "lease" IS NULL)) AND "deadline" > (clock_timestamp() AT TIME ZONE 'UTC')
      RETURNING *`;
     if (!updated) continue;
     const envelopes = auth.grant.machineEnvelopes as Record<string,string> | null;
     if (!envelopes?.[machineId]) deny('permission-denied');
     return { record: boundTurnRecord(updated,auth.binding), lease, sequence:updated.sequence, input: row.input, envelope: envelopes[machineId], kind: auth.grant.kind, grantId: auth.grant.id, ownerId, scope: auth.grant.scope };
    }
    return null;
   });
  },
  async attachSession(ownerId: string, machineId: string, id: string, input: {lease: string; sessionId: string}) {
   return serviceTransaction(database, ownerId, async tx => {
    const before = await tx.appChatTurn.findUnique({where:{id}});
    if (!before?.bindingId) deny('permission-denied');
    const auth = await authorizeWorkerBinding(tx, ownerId, machineId, before.bindingId);
    if (!await tx.machine.findFirst({where:{id:machineId,accountId:ownerId}})) deny('permission-denied');
    await lockTurn(tx,id);
    const row = await tx.appChatTurn.findUniqueOrThrow({where:{id}});
    if (row.state !== 'running' || row.lease !== input.lease || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now() || row.deadline.getTime() <= Date.now()) deny('execution-interrupted');
    const session = await tx.session.findFirst({where:{id:input.sessionId,accountId:ownerId,tag:`app-service:${before.bindingId}`}});
    if (!session) deny('permission-denied');
    if (auth.sessionId && auth.sessionId !== session.id) deny('revision-conflict');
    await tx.aIServiceBinding.update({where:{id:before.bindingId},data:{sessionId:session.id}});
    await tx.appChatTurn.update({where:{id},data:{sessionId:session.id}});
    return {sessionId:session.id};
   });
  },
  async publish(ownerId: string, machineId: string, id: string, input: { lease: string; output?: string; sequence?: number; status?: 'completed'|'failed'|'cancelled'; actual?: TurnActual; error?: ServiceError; phase?: TurnPhase }) {
   return serviceTransaction(database, ownerId, async tx => {
    // Match claim/probe lock order before renewing liveness for this worker.
    await tx.$queryRaw`SELECT "machineId" FROM "AppChatWorker" WHERE "machineId" = ${machineId} AND "accountId" = ${ownerId} FOR UPDATE`;
    const before = await tx.appChatTurn.findUnique({ where: { id } });
    if (!before?.bindingId) deny('permission-denied');
    const auth = await authorizeWorkerBinding(tx,ownerId,machineId,before.bindingId);
    await lockServiceQuota(tx, auth.grant.id);
    await lockTurn(tx,id);
    const row = await tx.appChatTurn.findUniqueOrThrow({ where: { id } });
    if (!['running','cancel-requested'].includes(row.state) || row.lease !== input.lease || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now() || row.deadline.getTime() <= Date.now()) deny('execution-interrupted');
    if (row.state === 'cancel-requested' && input.status !== 'cancelled' && !(row.minimumProtocol === 5 && row.sessionId && ['completed','failed'].includes(input.status ?? '')) && !(input.phase === 'recovering' && input.status === undefined && input.output === undefined)) deny('execution-interrupted');
    if (input.output && Buffer.byteLength(input.output) > (row.minimumProtocol === 5 ? NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES : 1024*1024)) throw new AIServicePayloadTooLargeError();
    if (input.output && (!input.sequence || input.sequence <= row.sequence)) deny('invalid-request');
    if (input.status === 'completed' && !input.output && !row.output) deny('invalid-request');
    const phase = input.phase === undefined ? undefined : TurnPhaseSchema.parse(input.phase);
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
    await tx.appChatTurn.update({ where: { id }, data: { ...(phase ? {phase} : {}), ...(input.output ? { output: input.output, sequence: input.sequence } : {}), ...(actual ? { actual } : {}), ...(error ? { serviceError: error } : {}),
     state: input.status ?? row.state, ...(input.status ? { completedAt: new Date(), lease: null, leaseUntil: null } : { leaseUntil: new Date(Date.now()+15000) }) } });
    // Only an authorized, current lease proves that the worker is still online.
    await tx.appChatWorker.updateMany({ where: { machineId, accountId: ownerId, serviceProtocol: 'ai-services/1' }, data: { activeUntil: new Date(Date.now()+45000) } });
    return { accepted: true };
   });
  },
 };
}
export type ServiceTurns = ReturnType<typeof createServiceTurns>;
