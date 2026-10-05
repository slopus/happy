import { serviceTransaction } from './transactions';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
    CapabilityCatalogSchema, ExecutionBindingSchema, ServicePrincipalSchema, ServiceReasoningSchema,
    ServicePermissionsSchema, ServiceConfigSchema, type CapabilityCatalog, type ExecutionBinding,
    type ServicePrincipal, type ServiceTarget, type ServiceReasoning, type ServicePermission,
} from '@slopus/happy-wire';
import { z } from 'zod';
import { createApplicationRegistry } from './registry';
import { deny } from './errors';

/** Only the authenticated daemon/runtime adapter can implement this source.
 * It must verify owner, device and native account identity before returning data.
 * A persisted observation is not a live check. There is no HTTP ingestion endpoint.
 */
export interface TrustedCapabilitySource {
    readLive(ownerId: string, target: ServiceTarget, principal?: ServicePrincipal): Promise<CapabilityCatalog | null>;
}
export const BindingOverridesSchema = z.object({
    modelId: z.string().min(1).max(256).nullable().optional(),
    reasoning: ServiceReasoningSchema.optional(), permissions: ServicePermissionsSchema.optional(),
}).strict();
export type BindingOverrides = z.infer<typeof BindingOverridesSchema>;

export function targetKey(target: ServiceTarget): string {
    return JSON.stringify(target.engine === 'codex'
        ? [target.machineId, target.engine, target.accountRef.id]
        : [target.machineId, target.engine, target.accountRef.machineId, target.accountRef.identityId]);
}
export async function readTrustedCatalog(source: TrustedCapabilitySource | undefined, ownerId: string, target: ServiceTarget, principal?: ServicePrincipal): Promise<CapabilityCatalog | null> {
    const raw = await source?.readLive(ownerId, target, principal ?? { kind: 'owner', ownerId });
    if (!raw) return null;
    const parsed = CapabilityCatalogSchema.safeParse(raw);
    if (!parsed.success || targetKey(parsed.data) !== targetKey(target)) deny('parameter-unsupported');
    const now = Date.now();
    if (parsed.data.observedAt > now || now - parsed.data.observedAt > 60_000) deny('machine-offline');
    if (parsed.data.availability !== 'online') deny('machine-offline');
    return parsed.data;
}

export async function cacheCatalog(tx: Prisma.TransactionClient, ownerId: string, catalog: CapabilityCatalog): Promise<void> {
    const key = targetKey(catalog);
    await tx.$executeRaw`INSERT INTO "AIServiceCapabilitySnapshot" ("ownerId", "targetKey", "catalog", "observedAt")
        VALUES (${ownerId}, ${key}, ${JSON.stringify(catalog)}::jsonb, ${new Date(catalog.observedAt)})
        ON CONFLICT ("ownerId", "targetKey") DO UPDATE
        SET "catalog" = EXCLUDED."catalog", "observedAt" = EXCLUDED."observedAt"
        WHERE "AIServiceCapabilitySnapshot"."observedAt" <= EXCLUDED."observedAt"`;
}

export function validateCatalogOptions(catalog: CapabilityCatalog, requestedModel: string | null, reasoning: ServiceReasoning, permissions: ServicePermission[]) {
    const modelId = requestedModel ?? catalog.defaultModelId;
    const model = catalog.models.find(value => value.id === modelId);
    if (!model) deny('model-unavailable');
    if (permissions.includes('images') && !model.supportsImages) deny('parameter-unsupported');
    if (reasoning.mode === 'default' ? !model.reasoning.supportsDefault : !model.reasoning.values.includes(reasoning.value)) deny('parameter-unsupported');
}

export interface BindingDependencies {
    lockService(tx: Prisma.TransactionClient, ownerId: string, serviceId: string): Promise<{ id: string; enabled: boolean; revision: number }>;
    verifyIdentity(tx: Prisma.TransactionClient, ownerId: string, target: ServiceTarget, expectedFingerprint?: string, observation?: CapabilityCatalog | null, preflight?: boolean): Promise<{ fingerprint: string; catalog: CapabilityCatalog | null }>;
}
export async function authorizeServicePrincipal(tx: Prisma.TransactionClient, input: ServicePrincipal, appId: string, serviceId: string) {
        const parsed = ServicePrincipalSchema.safeParse(input);
        if (!parsed.success) deny('permission-denied');
        const principal = parsed.data;
        const policy = await createApplicationRegistry(tx).readApplication(appId);
        if (principal.kind === 'owner') return { principal, policy, grant: null };
        await tx.$queryRaw`SELECT "id" FROM "AIServiceAuthorization" WHERE "id" = ${principal.grantId} FOR SHARE`;
        const grant = await tx.aIServiceAuthorization.findUnique({ where: { id: principal.grantId } });
        if (!grant || grant.ownerId !== principal.ownerId || grant.kind !== principal.kind || grant.appId !== appId || grant.serviceId !== serviceId) deny('permission-denied');
        if (grant.revokedAt) deny('authorization-revoked');
        if (grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) deny('authorization-expired');
        // Principal scope is a receipt from authentication, not authority on its own.
        if (JSON.stringify(grant.scope) !== JSON.stringify(principal.scope)) {
            // JSONB changes key order. Compare canonical schema output instead.
            const canonical = ServicePrincipalSchema.safeParse({ ...principal, scope: grant.scope });
            if (!canonical.success || JSON.stringify(canonical.data) !== JSON.stringify(principal)) deny('permission-denied');
        }
        return { principal, policy, grant };
    }

export function createBindingStore(database: PrismaClient, source: TrustedCapabilitySource | undefined, dependencies: BindingDependencies) {
    async function readStored(tx: Prisma.TransactionClient, principal: ServicePrincipal, appId: string, id: string) {
        const row = await tx.aIServiceBinding.findUnique({ where: { id } });
        if (!row || row.ownerId !== principal.ownerId || row.appId !== appId) deny('permission-denied');
        const auth = await authorizeServicePrincipal(tx, principal, appId, row.serviceId);
        if (auth.principal.kind !== 'owner' && row.authorizationId !== auth.grant!.id) deny('permission-denied');
        const binding = ExecutionBindingSchema.parse(row.snapshot);
        if (binding.permissions.some(value => !auth.policy.capabilities.includes(value))) deny('permission-denied');
        if (auth.grant) {
            if (!auth.principal.scope.targets.some(target => targetKey(target) === targetKey(binding))) deny('permission-denied');
            if (binding.permissions.some(value => !auth.principal.scope.permissions.includes(value))) deny('permission-denied');
        }
        return { row, binding };
    }
    async function prepareBinding(tx: Prisma.TransactionClient, principal: ServicePrincipal, appId: string, serviceId: string, options: BindingOverrides) {
        const service = await dependencies.lockService(tx, principal.ownerId, serviceId);
        if (!service.enabled) deny('service-disabled');
        const { policy, grant, principal: parsed } = await authorizeServicePrincipal(tx, principal, appId, serviceId);
        const revision = await tx.aIServiceRevision.findUniqueOrThrow({ where: { serviceId_revision: { serviceId, revision: service.revision } } });
        const config = ServiceConfigSchema.parse(revision.config);
        const permissions = options.permissions ?? (parsed.kind === 'owner' ? ['chat' as const] : parsed.scope.permissions);
        if (permissions.some(value => !policy.capabilities.includes(value))) deny('permission-denied');
        if (grant) {
            if (!parsed.scope.targets.some(target => targetKey(target) === targetKey(config))) deny('consent-required');
            if (permissions.some(value => !parsed.scope.permissions.includes(value))) deny('permission-denied');
            if (options.modelId !== undefined && !grant.allowModelOverride) deny('permission-denied');
            if (options.reasoning !== undefined && !grant.allowReasoningOverride) deny('permission-denied');
        }
        await dependencies.verifyIdentity(tx, principal.ownerId, config, revision.accountFingerprint, null, true);
        return { service, revision, config, permissions, grant };
    }
    async function withValidatedBinding<T>(principal: ServicePrincipal, appId: string, id: string,
        persist: (tx: Prisma.TransactionClient, binding: ExecutionBinding) => Promise<T>, live = true): Promise<T> {
        const preflight = await serviceTransaction(database, principal.ownerId, async tx => {
            const stored = await readStored(tx, principal, appId, id);
            const service = await dependencies.lockService(tx, principal.ownerId, stored.row.serviceId);
            if (!service.enabled) deny('service-disabled');
            await dependencies.verifyIdentity(tx, principal.ownerId, stored.binding, stored.row.accountFingerprint, null, true);
            return stored;
        });
        const catalog = live ? await readTrustedCatalog(source, principal.ownerId, preflight.binding, principal) : null;
        if (live && !catalog) deny('machine-offline');
        return serviceTransaction(database, principal.ownerId, async tx => {
            const { row, binding } = await readStored(tx, principal, appId, id);
            const service = await dependencies.lockService(tx, principal.ownerId, row.serviceId);
            if (!service.enabled) deny('service-disabled');
            await dependencies.verifyIdentity(tx, principal.ownerId, binding, row.accountFingerprint, catalog, !live);
            if (catalog) {
                validateCatalogOptions(catalog, binding.requestedModel, binding.reasoning, binding.permissions);
                await cacheCatalog(tx, principal.ownerId, catalog);
            }
            return persist(tx, binding);
        });
    }
    return {
        withValidatedBinding,
        async resolveBinding(principal: ServicePrincipal, appId: string, serviceId: string, input: BindingOverrides): Promise<ExecutionBinding> {
            const options = BindingOverridesSchema.safeParse(input);
            if (!options.success) deny('invalid-request');
            // Retry only configuration contention. Never reuse an observation for a different revision.
            for (let attempt = 0; attempt < 3; attempt++) {
                const before = await serviceTransaction(database, principal.ownerId, tx => prepareBinding(tx, principal, appId, serviceId, options.data));
                const catalog = await readTrustedCatalog(source, principal.ownerId, before.config, principal);
                if (!catalog) deny('machine-offline');
                const result = await serviceTransaction(database, principal.ownerId, async tx => {
                    const current = await prepareBinding(tx, principal, appId, serviceId, options.data);
                    if (before.service.revision !== current.service.revision) return null;
                    const { service, revision, config, permissions, grant } = current;
                    await dependencies.verifyIdentity(tx, principal.ownerId, config, revision.accountFingerprint, catalog);
                    const requestedModel = options.data.modelId === undefined ? config.modelId : options.data.modelId;
                    const reasoning = options.data.reasoning ?? config.reasoning;
                    validateCatalogOptions(catalog, requestedModel, reasoning, permissions);
                    const binding = ExecutionBindingSchema.parse({ id: randomUUID(), appId, serviceId, revision: service.revision,
                        machineId: config.machineId, engine: config.engine, accountRef: config.accountRef, requestedModel, reasoning, permissions });
                    await cacheCatalog(tx, principal.ownerId, catalog);
                    await tx.aIServiceBinding.create({ data: { id: binding.id, ownerId: principal.ownerId, appId, serviceId,
                        revision: service.revision, authorizationId: grant?.id, snapshot: binding,
                        accountFingerprint: revision.accountFingerprint, capabilityObservedAt: new Date(catalog.observedAt) } });
                    return binding;
                });
                if (result) return result;
            }
            return deny('revision-conflict');
        },
        async readBinding(principal: ServicePrincipal, appId: string, id: string): Promise<ExecutionBinding> {
            return serviceTransaction(database, principal.ownerId, async tx => (await readStored(tx, principal, appId, id)).binding);
        },
        async validateBinding(principal: ServicePrincipal, appId: string, id: string): Promise<ExecutionBinding> {
            return withValidatedBinding(principal, appId, id, async (_tx, binding) => binding);
        },
    };
}
