import type { Prisma } from '@prisma/client';
import { ServicePrincipalSchema, ServiceTargetSchema, type ServicePrincipal, type ServiceTarget } from '@slopus/happy-wire';
import { authorizeServicePrincipal, targetKey } from './bindings';
import { verifyServiceIdentity } from './store';
import { authorizeWorkerBinding } from './turns';
import { deny } from './errors';
export async function authorizeProbe(tx: Prisma.TransactionClient, principal: ServicePrincipal, target: ServiceTarget, fingerprint?: string) {
 if (principal.kind !== 'owner') {
  await authorizeServicePrincipal(tx,principal,principal.scope.appId,principal.scope.serviceId);
  if (!principal.scope.targets.some(value => targetKey(value) === targetKey(target))) deny('permission-denied');
  await tx.$queryRaw`SELECT "id" FROM "AIService" WHERE "id" = ${principal.scope.serviceId} AND "ownerId" = ${principal.ownerId} FOR SHARE`;
  const service = await tx.aIService.findFirst({ where: { id: principal.scope.serviceId, ownerId: principal.ownerId, enabled: true, deletedAt: null } });
  if (!service) deny('service-disabled');
 }
 return verifyServiceIdentity(tx,principal.ownerId,target,fingerprint,null,true);
}
export type ServiceCredentialAuthority = { kind: 'probe'|'turn'; id: string; lease: string };
export async function authorizeServiceCredential(tx: Prisma.TransactionClient, ownerId: string, machineId: string, authority: ServiceCredentialAuthority) {
 if (authority.kind === 'probe') {
  const probe = await tx.aIServiceProbe.findFirst({ where: { id: authority.id, ownerId, machineId, lease: authority.lease, state: 'running', deadline: { gt: new Date() } } });
  if (!probe) deny('execution-interrupted');
  const principal = ServicePrincipalSchema.parse(probe.principal), target = ServiceTargetSchema.parse(probe.target);
  await authorizeProbe(tx,principal,target,probe.fingerprint);
  return target;
 }
 const row = await tx.appChatTurn.findFirst({ where: { id: authority.id, lease: authority.lease, state: 'running', leaseUntil: { gt: new Date() }, deadline: { gt: new Date() } } });
 if (!row?.bindingId) deny('execution-interrupted');
 return (await authorizeWorkerBinding(tx,ownerId,machineId,row.bindingId)).binding;
}
