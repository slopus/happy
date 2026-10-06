import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';
import type { PrismaClient } from '@prisma/client';
import { ServicePrincipalSchema, ServiceGrantScopeSchema, ServiceGrantSchema, type GrantReceipt, type ServiceGrantScope, type ServicePrincipal } from '@slopus/happy-wire';
import type { AIServiceStore } from './store';
import { deny } from './errors';
import { createApplicationRegistry } from './registry';
import { authorizeServicePrincipal } from './bindings';

export const serviceDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const digestMatches = (digest: string, value: string) => /^[a-f0-9]{64}$/.test(digest) && timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(serviceDigest(value),'hex'));
export function sealServiceEnvelope(value: unknown, publicKey: string): string {
    const key = Buffer.from(publicKey, 'base64');
    if (key.length !== 32) deny('protocol-incompatible');
    const ephemeral = nacl.box.keyPair(), nonce = randomBytes(24);
    return Buffer.concat([ephemeral.publicKey, nonce, nacl.box(Buffer.from(JSON.stringify(value)), nonce, key, ephemeral.secretKey)]).toString('base64');
}
export function createServiceGrants(database: PrismaClient, store: AIServiceStore) {
    return {
        /** Trusted operator/backend provisioning API. Deliberately has no browser HTTP issuance route. */
        async issueServiceGrant(ownerId: string, appId: string, serviceId: string, scope: ServiceGrantScope): Promise<GrantReceipt> {
            const parsed = ServiceGrantScopeSchema.safeParse(scope);
            if (!parsed.success || scope.appId !== appId || scope.serviceId !== serviceId) deny('invalid-request');
            const id = randomUUID(), secret = randomBytes(32).toString('base64url'), messageKey = randomBytes(32).toString('base64');
            const credential = `paws_service.${id}.${secret}`;
            const grant = await store.registerAuthorization(ownerId, { id, kind: 'platform-grant', scope, allowModelOverride: true, allowReasoningOverride: true }, async (tx, grant) => {
                const envelopes: Record<string, string> = {};
                for (const machineId of new Set(scope.targets.map(target => target.machineId))) {
                    const worker = await tx.appChatWorker.findFirst({ where: { machineId, accountId: ownerId, serviceProtocol: 'ai-services/1', activeUntil: { gt: new Date() } } });
                    if (!worker?.servicePublicKey) deny('machine-offline');
                    envelopes[machineId] = sealServiceEnvelope({ protocol: grant.protocol, grantId: id, ownerId, appId, serviceId, scope, machineId, messageKey }, worker.servicePublicKey);
                }
                await tx.aIServiceAuthorization.update({ where: { id }, data: { credentialDigest: serviceDigest(credential), machineEnvelopes: envelopes } });
                await tx.appDelegation.create({ data: { id, appId, accountId: ownerId, protocol: 4, state: 'service-ready', publicKey: '', challengeHash: '', requestExpiresAt: new Date(), expiresAt: scope.expiresAt === null ? null : new Date(scope.expiresAt) } });
            });
            return { ...grant, credential, messageKey };
        },
        async createPersonalPairing(appId: string, origin: string, publicKey: string, challengeHash: string) {
            await store.readApplication(appId, origin);
            if (Buffer.from(publicKey, 'base64').length !== 32 || !/^[a-f0-9]{64}$/.test(challengeHash)) deny('invalid-request');
            return database.$transaction(async tx => {
                await tx.appDelegation.deleteMany({ where: { state: 'service-pending', requestExpiresAt: { lt: new Date() } } });
                if (await tx.appDelegation.count({ where: { state: 'service-pending' } }) >= 1000) deny('resource-busy');
                const row = await tx.appDelegation.create({ data: { id: randomUUID(), appId, publicKey, challengeHash, state: 'service-pending', protocol: 4, requestExpiresAt: new Date(Date.now() + 600000) } });
                return { id: row.id, expiresAt: row.requestExpiresAt.getTime(), protocol: 'ai-services/1' as const };
            });
        },
        async describePersonalPairing(id: string) {
            const row = await database.appDelegation.findUnique({ where: { id } });
            if (!row || row.state !== 'service-pending' || row.requestExpiresAt.getTime() <= Date.now()) deny('authorization-expired');
            return { id, app: await store.readApplication(row.appId), publicKey: row.publicKey, expiresAt: row.requestExpiresAt.getTime(), protocol: 'ai-services/1' as const };
        },
        async approvePersonalPairing(ownerId: string, id: string, scope: ServiceGrantScope, appEnvelope: string, machineEnvelopes: Record<string, string>) {
            if (appEnvelope.length < 80 || appEnvelope.length > 16384 || Object.values(machineEnvelopes).some(value => value.length < 80 || value.length > 16384)) deny('invalid-request');
            const machines = [...new Set(scope.targets.map(target => target.machineId))].sort();
            if (JSON.stringify(machines) !== JSON.stringify(Object.keys(machineEnvelopes).sort())) deny('permission-denied');
            return store.registerAuthorization(ownerId, { id, kind: 'personal-grant', scope, allowModelOverride: true, allowReasoningOverride: true }, async tx => {
                const row = await tx.appDelegation.findUnique({ where: { id } });
                if (!row || row.appId !== scope.appId || row.state !== 'service-pending' || row.requestExpiresAt.getTime() <= Date.now()) deny('authorization-expired');
                await tx.aIServiceAuthorization.update({ where: { id }, data: { machineEnvelopes } });
                await tx.appDelegation.update({ where: { id }, data: { accountId: ownerId, state: 'service-approved', appEnvelope } });
            });
        },
        async redeemPersonalPairing(id: string, origin: string, verifier: string, secret: string) {
            if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) deny('permission-denied');
            return database.$transaction(async tx => {
                await tx.$queryRaw`SELECT "id" FROM "AppDelegation" WHERE "id" = ${id} FOR UPDATE`;
                const pairing = await tx.appDelegation.findUnique({ where: { id } });
                if (!pairing || !digestMatches(pairing.challengeHash,verifier) || pairing.requestExpiresAt.getTime() <= Date.now()) deny('authorization-expired');
                await createApplicationRegistry(tx).readApplication(pairing.appId, origin);
                if (pairing.state === 'service-pending') return { state: 'pending' as const };
                const grant = await tx.aIServiceAuthorization.findUnique({ where: { id } });
                if (!grant || grant.kind !== 'personal-grant' || grant.revokedAt || (grant.expiresAt && grant.expiresAt.getTime() <= Date.now())) deny('authorization-revoked');
                const credential = `paws_service.${id}.${secret}`, digest = serviceDigest(credential);
                if (grant.credentialDigest && grant.credentialDigest !== digest) deny('permission-denied');
                if (!['service-approved', 'service-redeemed'].includes(pairing.state)) deny('permission-denied');
                // First redemption makes the credential usable atomically. A retry
                // must be read-only: turn start holds grant SHARE before delegation,
                // so updating the grant while holding delegation would invert locks.
                if (pairing.state === 'service-approved') {
                    if (grant.credentialDigest) deny('permission-denied');
                    await tx.aIServiceAuthorization.update({ where: { id }, data: { credentialDigest: digest } });
                    await tx.appDelegation.update({ where: { id }, data: { state: 'service-redeemed' } });
                } else if (grant.credentialDigest !== digest) deny('permission-denied');
                // The recipient assembles GrantReceipt only after local decryption. No clear key exists here.
                return { state: 'authorized' as const, id, protocol: 'ai-services/1' as const, envelope: pairing.appEnvelope,
                    grant: ServiceGrantSchema.parse({ id: grant.id, ownerId: grant.ownerId, kind: grant.kind, protocol: 'ai-services/1', scope: grant.scope, createdAt: grant.createdAt.getTime(), revokedAt: null }) };
            });
        },
        async authenticate(credential: string, origin?: string): Promise<Exclude<ServicePrincipal, { kind: 'owner' }>> {
            const match = /^paws_service\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/.exec(credential);
            if (!match) deny('permission-denied');
            return database.$transaction(async tx => {
                const grant = await tx.aIServiceAuthorization.findUnique({ where: { id: match[1] } });
                if (!grant?.credentialDigest || !digestMatches(grant.credentialDigest,credential)) deny('permission-denied');
                const principal = ServicePrincipalSchema.parse({ kind: grant.kind, ownerId: grant.ownerId, grantId: grant.id, scope: grant.scope });
                if (principal.kind === 'owner') deny('permission-denied');
                const { policy } = await authorizeServicePrincipal(tx, principal, grant.appId, grant.serviceId);
                if (principal.kind === 'personal-grant' && (!origin || !policy.origins.includes(origin))) deny('permission-denied');
                if (principal.kind === 'platform-grant' && origin !== undefined) deny('permission-denied');
                return principal;
            });
        },
    };
}
export type ServiceGrants = ReturnType<typeof createServiceGrants>;
