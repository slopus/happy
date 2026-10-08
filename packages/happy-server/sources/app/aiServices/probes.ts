import { serviceTransaction } from './transactions';
import { randomUUID, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ServiceErrorCodeSchema, CapabilityCatalogSchema, ServicePrincipalSchema, ServiceTargetSchema, type CapabilityCatalog, type ServicePrincipal, type ServiceTarget } from '@slopus/happy-wire';
import type { TrustedCapabilitySource } from './bindings';
import { targetKey } from './bindings';
import { authorizeProbe } from './authority';
import { deny, AIServiceError } from './errors';
export function createServiceProbes(database: PrismaClient) {
 const source: TrustedCapabilitySource = {
  async readLive(ownerId, target, authority = { kind: 'owner', ownerId }) {
   const principal = ServicePrincipalSchema.parse(authority);
   if (principal.ownerId !== ownerId) deny('permission-denied');
   let id: string = randomUUID();
   const cached = await serviceTransaction(database, ownerId, async tx => {
    await tx.$queryRaw`SELECT "machineId" FROM "AppChatWorker" WHERE "machineId" = ${target.machineId} AND "accountId" = ${ownerId} FOR UPDATE`;
    await tx.aIServiceProbe.updateMany({ where: { machineId: target.machineId, state: { in: ['queued','running'] }, deadline: { lte: new Date() } }, data: { state: 'failed', lease: null, error: 'execution-interrupted' } });
    const identity = await authorizeProbe(tx,principal,target);
    const worker = await tx.appChatWorker.findFirst({ where: { machineId: target.machineId, accountId: ownerId, serviceProtocol: 'ai-services/1', activeUntil: { gt: new Date() } } });
    if (!worker) deny('machine-offline');
    // A catalog is descriptive data, never authorization. Reuse only a recent
    // trusted observation for this exact owner/target/account fingerprint, after
    // the caller's CURRENT grant and worker liveness have been checked above.
    // Claude identity is device-local: its preflight fingerprint is not a fresh
    // login observation. Preserve live discovery for that engine.
    const recent = target.engine === 'codex' ? await tx.aIServiceProbe.findFirst({ where: { ownerId, machineId: target.machineId,
     target: { equals: ServiceTargetSchema.parse(target) }, fingerprint: identity.fingerprint,
     state: 'completed', createdAt: { gt: new Date(Date.now()-60000) } }, orderBy: { createdAt: 'desc' } }) : null;
    const catalog = CapabilityCatalogSchema.safeParse(recent?.catalog);
    if (catalog.success && catalog.data.availability === 'online' && targetKey(catalog.data) === targetKey(target)
     && catalog.data.observedAt <= Date.now() && Date.now()-catalog.data.observedAt < 60000) return catalog.data;
    // Concurrent reads by the same principal share one probe. Different grants
    // cannot lend each other execution authority or keep a revoked probe alive.
    const pending = await tx.aIServiceProbe.findFirst({ where: { ownerId, machineId: target.machineId,
     target: { equals: ServiceTargetSchema.parse(target) }, principal: { equals: principal }, fingerprint: identity.fingerprint,
     state: { in: ['queued','running'] }, deadline: { gt: new Date() } } });
    if (pending) { id = pending.id; return null; }
    if (await tx.appChatTurn.count({ where: { state: { in: ['running','cancel-requested'] }, OR: [{ binding: { ownerId, snapshot: { path: ['machineId'], equals: target.machineId } } }, { conversation: { grant: { accountId: ownerId, machineId: target.machineId } } }] } })) deny('resource-busy');
    await tx.aIServiceProbe.deleteMany({ where: { deadline: { lt: new Date(Date.now()-60000) } } });
    if (await tx.aIServiceProbe.count({ where: { ownerId, machineId: target.machineId, deadline: { gt: new Date() }, state: { in: ['queued','running'] } } })) deny('resource-busy');
    await tx.aIServiceProbe.create({ data: { id, ownerId, machineId: target.machineId, target: { machineId: target.machineId, engine: target.engine, accountRef: target.accountRef }, principal, fingerprint: identity.fingerprint, deadline: new Date(Date.now()+25000) } });
    return null;
   });
   if (cached) return cached;
   // Polling never holds a transaction or device/identity lock. Credential callbacks can commit.
   for (;;) {
    const row = await database.aIServiceProbe.findUniqueOrThrow({ where: { id } });
    if (row.state === 'completed') {
     await serviceTransaction(database, ownerId, tx => authorizeProbe(tx,principal,target,row.fingerprint));
     return CapabilityCatalogSchema.parse(row.catalog);
    }
    if (row.state === 'failed') throw new AIServiceError(ServiceErrorCodeSchema.safeParse(row.error).data ?? 'execution-interrupted');
    if (row.deadline.getTime() <= Date.now()) { await database.aIServiceProbe.updateMany({ where: { id, state: { in: ['queued','running'] } }, data: { state: 'failed', lease: null, error: 'execution-interrupted' } }); deny('machine-offline'); }
    await new Promise(resolve => setTimeout(resolve,100));
   }
  },
 };
 return {
  source,
  async announce(ownerId: string, machineId: string, publicKey: string, claudeIdentity?: { identityId: string; observedAt: number } | null, nativeSessions = false) {
   if (Buffer.from(publicKey,'base64').length !== 32) deny('invalid-request');
   if (!await database.machine.findFirst({ where: { id: machineId, accountId: ownerId } })) deny('permission-denied');
   if (claudeIdentity && (!/^claude:[a-f0-9]{64}$/.test(claudeIdentity.identityId) || claudeIdentity.observedAt > Date.now() || Date.now()-claudeIdentity.observedAt > 60000)) deny('invalid-request');
   const identity = { nativeSessions, serviceClaudeIdentity: claudeIdentity?.identityId ?? null, serviceClaudeObservedAt: claudeIdentity ? new Date(claudeIdentity.observedAt) : null };
   await database.appChatWorker.upsert({ where: { machineId }, create: { ...identity, machineId, accountId: ownerId, protocol: 3, serviceProtocol: 'ai-services/1', servicePublicKey: publicKey, activeUntil: new Date(Date.now()+45000) }, update: { ...identity, serviceProtocol: 'ai-services/1', servicePublicKey: publicKey, activeUntil: new Date(Date.now()+45000) } });
   return { protocol: 'ai-services/1' };
  },
  async claim(ownerId: string, machineId: string) {
   return serviceTransaction(database, ownerId, async tx => {
    await tx.$queryRaw`SELECT "machineId" FROM "AppChatWorker" WHERE "machineId" = ${machineId} AND "accountId" = ${ownerId} FOR UPDATE`;
    if (!await tx.machine.findFirst({ where: { id: machineId, accountId: ownerId } })) deny('permission-denied');
    const row = await tx.aIServiceProbe.findFirst({ where: { ownerId, machineId, state: 'queued', deadline: { gt: new Date() } }, orderBy: { createdAt: 'asc' } });
    if (!row) return null;
    const principal = ServicePrincipalSchema.parse(row.principal), target = ServiceTargetSchema.parse(row.target);
    await authorizeProbe(tx,principal,target,row.fingerprint);
    const lease = randomBytes(32).toString('base64url');
    await tx.aIServiceProbe.update({ where: { id: row.id }, data: { state: 'running', lease } });
    return { id: row.id, target, lease, deadline: row.deadline.getTime() };
   });
  },
  async publish(ownerId: string, machineId: string, id: string, lease: string, catalog: CapabilityCatalog | null, error?: string) {
   return serviceTransaction(database, ownerId, async tx => {
    await tx.$queryRaw`SELECT "id" FROM "AIServiceProbe" WHERE "id" = ${id} FOR UPDATE`;
    const row = await tx.aIServiceProbe.findFirst({ where: { id, ownerId, machineId, state: 'running', lease, deadline: { gt: new Date() } } });
    if (!row) deny('execution-interrupted');
    const principal = ServicePrincipalSchema.parse(row.principal), target = ServiceTargetSchema.parse(row.target);
    await authorizeProbe(tx,principal,target,row.fingerprint);
    if (catalog) {
     const parsed = CapabilityCatalogSchema.parse(catalog);
     if (targetKey(parsed) !== targetKey(target) || parsed.observedAt > Date.now() || Date.now()-parsed.observedAt > 60000 || parsed.availability !== 'online') deny('account-identity-changed');
    }
    await tx.aIServiceProbe.update({ where: { id }, data: { state: catalog ? 'completed' : 'failed', ...(catalog ? { catalog } : { error: ServiceErrorCodeSchema.safeParse(error).data ?? 'execution-interrupted' }), lease: null } });
    return { accepted: true };
   });
  },
 };
}
