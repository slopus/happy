import { serviceTransaction } from './transactions';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
    CapabilityCatalogSchema, ExecutionBindingSchema, ServicePrincipalSchema, ServiceReasoningSchema,
    ServicePermissionsSchema, ServiceConfigSchema, ServiceTargetSchema, ServicePermissionModeSchema, ServiceTierSchema,
    type CapabilityCatalog, type ExecutionBinding, type ServiceConfig,
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
    target: ServiceTargetSchema.optional(),
    modelId: z.string().min(1).max(256).nullable().optional(),
    reasoning: ServiceReasoningSchema.optional(), permissions: ServicePermissionsSchema.optional(),
    permissionMode: ServicePermissionModeSchema.optional(), serviceTier: ServiceTierSchema.optional(),
}).strict();
export type BindingOverrides = z.infer<typeof BindingOverridesSchema>;

export function targetKey(target: ServiceTarget): string {
    return JSON.stringify(target.engine === 'codex'
        ? [target.machineId, target.engine, target.accountRef.id]
        : [target.machineId, target.engine, target.accountRef.machineId, target.accountRef.identityId]);
}
/** A scoped grant follows the identity approved at issuance, never a replacement account. */
export function authorizedTargetFingerprint(grant: { targetFingerprints: unknown }, target: ServiceTarget, defaults: ServiceTarget, revisionFingerprint: string): string {
    if (grant.targetFingerprints === null) {
        if (targetKey(target) !== targetKey(defaults)) deny('consent-required');
        return revisionFingerprint;
    }
    const fingerprints = z.record(z.string(), z.string().min(1)).safeParse(grant.targetFingerprints);
    if (!fingerprints.success || !Object.prototype.hasOwnProperty.call(fingerprints.data, targetKey(target))) deny('consent-required');
    return fingerprints.data[targetKey(target)];
}
export async function readTrustedCatalog(source: TrustedCapabilitySource | undefined, ownerId: string, target: ServiceTarget, principal?: ServicePrincipal): Promise<CapabilityCatalog | null> {
    const nativeTarget = ServiceTargetSchema.parse({ machineId: target.machineId, engine: target.engine, accountRef: target.accountRef });
    const raw = await source?.readLive(ownerId, nativeTarget, principal ?? { kind: 'owner', ownerId });
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

export function validateCatalogOptions(catalog: CapabilityCatalog, requestedModel: string | null, reasoning: ServiceReasoning, permissions: ServicePermission[], execution: Pick<ServiceConfig, 'permissionMode' | 'serviceTier'> = {}) {
    const permissionMode = execution.permissionMode ?? 'chat-only';
    if (permissionMode !== 'chat-only' && !permissions.includes('tools')) deny('permission-denied');
    if (permissionMode !== 'chat-only' && !catalog.execution?.permissionModes.includes(permissionMode)) deny('parameter-unsupported');
    const modelId = requestedModel ?? catalog.defaultModelId;
    const model = catalog.models.find(value => value.id === modelId);
    if (!model) deny('model-unavailable');
    if (permissions.includes('images') && !model.supportsImages) deny('parameter-unsupported');
    if (reasoning.mode === 'default' ? !model.reasoning.supportsDefault : !model.reasoning.values.includes(reasoning.value)) deny('parameter-unsupported');
    if (execution.serviceTier === 'fast' && (!catalog.execution?.serviceTiers.includes('fast') || !model.serviceTiers?.includes('fast'))) deny('parameter-unsupported');
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
        if ((binding.permissionMode ?? 'chat-only') !== 'chat-only' && !binding.permissions.includes('tools')) deny('permission-denied');
        if (binding.permissions.some(value => !auth.policy.capabilities.includes(value))) deny('permission-denied');
        if (auth.grant) {
            if (!auth.principal.scope.targets.some(target => targetKey(target) === targetKey(binding))) deny('permission-denied');
            if (binding.permissions.some(value => !auth.principal.scope.permissions.includes(value))) deny('permission-denied');
        }
        return { row, binding };
    }
    function creationKey(value: string) {
        if (typeof value !== 'string' || !value.trim() || value.length > 256) deny('invalid-request');
        return value;
    }
    function canonicalInput(value: unknown): string {
        if (Array.isArray(value)) return '[' + value.map(canonicalInput).join(',') + ']';
        if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + canonicalInput(v)).join(',') + '}';
        return JSON.stringify(value);
    }
    async function recoverCreation(tx: Prisma.TransactionClient, principal: ServicePrincipal, appId: string, serviceId: string, appConversationId: string | undefined, options: BindingOverrides) {
        if (appConversationId === undefined) return null;
        if (principal.kind === 'owner') deny('permission-denied');
        // Preserve service -> grant lock order. This also serializes same-key final inserts.
        await tx.$queryRaw`SELECT "id" FROM "AIService" WHERE "id" = ${serviceId} AND "ownerId" = ${principal.ownerId} FOR UPDATE`;
        await authorizeServicePrincipal(tx, principal, appId, serviceId);
        const row = await tx.aIServiceBinding.findFirst({ where: { authorizationId: principal.grantId, appId, appConversationId: creationKey(appConversationId) } });
        if (!row) return null;
        if (row.serviceId !== serviceId || canonicalInput(row.creationInput) !== canonicalInput(options)) deny('invalid-request');
        return (await readStored(tx, principal, appId, row.id)).binding;
    }
    async function prepareBinding(tx: Prisma.TransactionClient, principal: ServicePrincipal, appId: string, serviceId: string, options: BindingOverrides) {
        const service = await dependencies.lockService(tx, principal.ownerId, serviceId);
        if (!service.enabled) deny('service-disabled');
        const { policy, grant, principal: parsed } = await authorizeServicePrincipal(tx, principal, appId, serviceId);
        const revision = await tx.aIServiceRevision.findUniqueOrThrow({ where: { serviceId_revision: { serviceId, revision: service.revision } } });
        const defaults = ServiceConfigSchema.parse(revision.config);
        const target = options.target ?? ServiceTargetSchema.parse({ machineId: defaults.machineId, engine: defaults.engine, accountRef: defaults.accountRef });
        const engineChanged = target.engine !== defaults.engine;
        const config = ServiceConfigSchema.parse({ ...defaults, ...target,
            modelId: options.modelId === undefined ? (engineChanged ? null : defaults.modelId) : options.modelId,
            reasoning: options.reasoning ?? (engineChanged ? { mode: 'default' } : defaults.reasoning),
            ...(engineChanged && defaults.serviceTier !== undefined ? { serviceTier: 'default' } : {}),
            ...(engineChanged && defaults.permissionMode === 'read-only' ? { permissionMode: 'chat-only' } : {}),
            ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
            ...(options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier }) });
        const permissions = options.permissions ?? (parsed.kind === 'owner' ? ['chat' as const] : parsed.scope.permissions)
            .filter(permission => policy.capabilities.includes(permission) && (permission !== 'tools' || (config.permissionMode ?? 'chat-only') !== 'chat-only'));
        if (permissions.some(value => !policy.capabilities.includes(value))) deny('permission-denied');
        if ((config.permissionMode ?? 'chat-only') !== 'chat-only' && !permissions.includes('tools')) deny('permission-denied');
        if (grant) {
            if (!parsed.scope.targets.some(target => targetKey(target) === targetKey(config))) deny('consent-required');
            if (permissions.some(value => !parsed.scope.permissions.includes(value))) deny('permission-denied');
            if (options.modelId !== undefined && !grant.allowModelOverride) deny('permission-denied');
            if (options.reasoning !== undefined && !grant.allowReasoningOverride) deny('permission-denied');
        }
        const expectedFingerprint = grant ? authorizedTargetFingerprint(grant, target, defaults, revision.accountFingerprint)
            : targetKey(target) === targetKey(defaults) ? revision.accountFingerprint : undefined;
        const identity = await dependencies.verifyIdentity(tx, principal.ownerId, config, expectedFingerprint, null, true);
        return { service, revision, config, permissions, grant, fingerprint: identity.fingerprint };
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
                validateCatalogOptions(catalog, binding.requestedModel, binding.reasoning, binding.permissions, binding);
                await cacheCatalog(tx, principal.ownerId, catalog);
            }
            return persist(tx, binding);
        });
    }
    return {
        withValidatedBinding,
        async resolveBinding(principal: ServicePrincipal, appId: string, serviceId: string, input: BindingOverrides, appConversationId?: string): Promise<ExecutionBinding> {
            const options = BindingOverridesSchema.safeParse(input);
            if (!options.success) deny('invalid-request');
            if (appConversationId !== undefined) creationKey(appConversationId);
            const recovered = await serviceTransaction(database, principal.ownerId, tx => recoverCreation(tx, principal, appId, serviceId, appConversationId, options.data));
            if (recovered) return recovered;
            // Retry only configuration contention. Never reuse an observation for a different revision.
            for (let attempt = 0; attempt < 3; attempt++) {
                const before = await serviceTransaction(database, principal.ownerId, tx => prepareBinding(tx, principal, appId, serviceId, options.data));
                const catalog = await readTrustedCatalog(source, principal.ownerId, before.config, principal);
                if (!catalog) deny('machine-offline');
                const result = await serviceTransaction(database, principal.ownerId, async tx => {
                    const recovered = await recoverCreation(tx, principal, appId, serviceId, appConversationId, options.data);
                    if (recovered) return recovered;
                    const current = await prepareBinding(tx, principal, appId, serviceId, options.data);
                    if (before.service.revision !== current.service.revision) return null;
                    const { service, config, grant, fingerprint } = current;
                    await dependencies.verifyIdentity(tx, principal.ownerId, config, before.fingerprint, catalog);
                    // Freeze the same trusted defaults the service picker displays. A null
                    // request must not silently pick a different local CLI config.
                    const requestedModel = config.modelId ?? catalog.defaultModelId;
                    const model = catalog.models.find(value => value.id === requestedModel);
                    const reasoning: ServiceReasoning = config.reasoning.mode === 'default' && model?.reasoning.defaultValue
                        ? { mode: 'explicit', value: model.reasoning.defaultValue }
                        : config.reasoning;
                    const permissions = options.data.permissions === undefined
                        ? current.permissions.filter(permission => permission !== 'images' || model?.supportsImages)
                        : current.permissions;
                    validateCatalogOptions(catalog, requestedModel, reasoning, permissions, config);
                    const binding = ExecutionBindingSchema.parse({ id: randomUUID(), appId, serviceId, revision: service.revision,
                        machineId: config.machineId, engine: config.engine, accountRef: config.accountRef, requestedModel, reasoning, permissions,
                        ...(config.permissionMode === undefined ? {} : { permissionMode: config.permissionMode }),
                        ...(config.serviceTier === undefined ? {} : { serviceTier: config.serviceTier }) });
                    await cacheCatalog(tx, principal.ownerId, catalog);
                    await tx.aIServiceBinding.create({ data: { id: binding.id, ownerId: principal.ownerId, appId, serviceId,
                        revision: service.revision, authorizationId: grant?.id, snapshot: binding,
                        appConversationId, creationInput: appConversationId === undefined ? undefined : options.data,
                        accountFingerprint: fingerprint, capabilityObservedAt: new Date(catalog.observedAt) } });
                    return binding;
                });
                if (result) return result;
            }
            return deny('revision-conflict');
        },
        async findApplicationBinding(principal: ServicePrincipal, appId: string, appConversationId: string): Promise<ExecutionBinding | null> {
            if (principal.kind === 'owner') deny('permission-denied');
            creationKey(appConversationId);
            return serviceTransaction(database, principal.ownerId, async tx => {
                await authorizeServicePrincipal(tx, principal, appId, principal.scope.serviceId);
                const row = await tx.aIServiceBinding.findFirst({ where: { authorizationId: principal.grantId, appId, appConversationId } });
                return row ? (await readStored(tx, principal, appId, row.id)).binding : null;
            });
        },
        async readBinding(principal: ServicePrincipal, appId: string, id: string): Promise<ExecutionBinding> {
            return serviceTransaction(database, principal.ownerId, async tx => (await readStored(tx, principal, appId, id)).binding);
        },
        async validateBinding(principal: ServicePrincipal, appId: string, id: string): Promise<ExecutionBinding> {
            return withValidatedBinding(principal, appId, id, async (_tx, binding) => binding);
        },
    };
}
