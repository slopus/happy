import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
    ServiceConfigSchema, ServiceRefSchema, ServiceRevisionSchema, ServiceGrantSchema,
    ServiceGrantScopeSchema, ServiceGrantKindSchema, type ServiceConfig, type ServiceRef,
    type ServiceRevision, type ServiceGrant,
} from '@slopus/happy-wire';
import { createBindingStore, readTrustedCatalog, cacheCatalog, validateCatalogOptions, type TrustedCapabilitySource } from './bindings';
import { createApplicationRegistry } from './registry';
import { deny } from './errors';
export { AIServiceError } from './errors';
export type { TrustedCapabilitySource, BindingOverrides } from './bindings';

const name = z.string().min(1).max(256).refine(value => value.trim().length > 0);
export const CreateServiceSchema = z.object({ name, config: ServiceConfigSchema, enabled: z.boolean().optional() }).strict();
export type CreateServiceInput = z.infer<typeof CreateServiceSchema>;
export const ServiceMetadataSchema = z.object({ name: name.optional(), enabled: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0);
const AuthorizationInputSchema = z.object({ id: z.string().min(1).max(256), kind: ServiceGrantKindSchema,
    scope: ServiceGrantScopeSchema, allowModelOverride: z.boolean(), allowReasoningOverride: z.boolean() }).strict();
export type AuthorizationInput = z.infer<typeof AuthorizationInputSchema>;

export function createAIServiceStore(database: PrismaClient, source?: TrustedCapabilitySource) {
    const registry = createApplicationRegistry(database);
    async function lockService(tx: Prisma.TransactionClient, ownerId: string, serviceId: string) {
        await tx.$queryRaw`SELECT "id" FROM "AIService" WHERE "id" = ${serviceId} AND "ownerId" = ${ownerId} FOR UPDATE`;
        const service = await tx.aIService.findFirst({ where: { id: serviceId, ownerId, deletedAt: null } });
        if (!service) deny('service-not-found');
        return service;
    }
    async function verifyConfig(tx: Prisma.TransactionClient, ownerId: string, config: ServiceConfig, expectedFingerprint?: string): Promise<string> {
        // Lock current identity rows through commit. Deletion cannot race a successful binding.
        await tx.$queryRaw`SELECT "id" FROM "Machine" WHERE "id" = ${config.machineId} AND "accountId" = ${ownerId} FOR SHARE`;
        if (!await tx.machine.findFirst({ where: { id: config.machineId, accountId: ownerId }, select: { id: true } })) deny('permission-denied');
        let fingerprint: string;
        if (config.engine === 'codex') {
            await tx.$queryRaw`SELECT "id" FROM "CodexAccountProfile" WHERE "id" = ${config.accountRef.id} AND "accountId" = ${ownerId} FOR SHARE`;
            const profile = await tx.codexAccountProfile.findFirst({ where: { id: config.accountRef.id, accountId: ownerId }, select: { externalAccountFingerprint: true, status: true } });
            if (!profile) deny('account-not-found');
            if (profile.status !== 'available') deny('account-login-required');
            fingerprint = profile.externalAccountFingerprint;
        } else {
            const catalog = await readTrustedCatalog(source, ownerId, config);
            if (!catalog) deny('account-not-found');
            fingerprint = config.accountRef.identityId;
            await cacheCatalog(tx, ownerId, catalog);
        }
        if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) deny('account-identity-changed');
        if (config.modelId !== null || config.reasoning.mode === 'explicit') {
            const catalog = await readTrustedCatalog(source, ownerId, config);
            if (!catalog) deny('machine-offline');
            validateCatalogOptions(catalog, config.modelId, config.reasoning, ['chat']);
            await cacheCatalog(tx, ownerId, catalog);
        }
        return fingerprint;
    }
    function requireRevision(actual: number, expected: number) {
        if (!Number.isSafeInteger(expected) || expected < 1) deny('invalid-request');
        if (actual !== expected) deny('revision-conflict');
    }
    const bindings = createBindingStore(database, source, { lockService, verifyConfig });
    return {
        ...registry, ...bindings,
        async createService(ownerId: string, input: CreateServiceInput): Promise<ServiceRef> {
            const parsed = CreateServiceSchema.safeParse(input);
            if (!parsed.success) deny('invalid-service-config');
            return database.$transaction(async tx => {
                const fingerprint = await verifyConfig(tx, ownerId, parsed.data.config);
                const service = await tx.aIService.create({ data: { id: randomUUID(), ownerId, name: parsed.data.name, enabled: parsed.data.enabled ?? true,
                    revisions: { create: { revision: 1, config: parsed.data.config, accountFingerprint: fingerprint } } } });
                return ServiceRefSchema.parse({ id: service.id, ownerId, name: service.name, enabled: service.enabled, revision: 1 });
            });
        },
        async updateService(ownerId: string, id: string, expectedRevision: number, input: ServiceConfig): Promise<ServiceRevision> {
            const parsed = ServiceConfigSchema.safeParse(input);
            if (!parsed.success) deny('invalid-service-config');
            return database.$transaction(async tx => {
                const service = await lockService(tx, ownerId, id);
                requireRevision(service.revision, expectedRevision);
                const fingerprint = await verifyConfig(tx, ownerId, parsed.data);
                const updated = await tx.aIService.updateMany({ where: { id, ownerId, revision: expectedRevision, deletedAt: null }, data: { revision: { increment: 1 } } });
                if (updated.count !== 1) deny('revision-conflict');
                const row = await tx.aIServiceRevision.create({ data: { serviceId: id, revision: expectedRevision + 1, config: parsed.data, accountFingerprint: fingerprint } });
                return ServiceRevisionSchema.parse({ serviceId: id, revision: row.revision, config: row.config, createdAt: row.createdAt.getTime() });
            });
        },
        async listServices(ownerId: string): Promise<ServiceRef[]> {
            const rows = await database.aIService.findMany({ where: { ownerId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, ownerId: true, name: true, enabled: true, revision: true } });
            return rows.map(row => ServiceRefSchema.parse(row));
        },
        async readService(ownerId: string, id: string): Promise<{ service: ServiceRef; revision: ServiceRevision }> {
            return database.$transaction(async tx => {
                const row = await lockService(tx, ownerId, id);
                const revision = await tx.aIServiceRevision.findUniqueOrThrow({ where: { serviceId_revision: { serviceId: id, revision: row.revision } } });
                return { service: ServiceRefSchema.parse({ id, ownerId, name: row.name, enabled: row.enabled, revision: row.revision }),
                    revision: ServiceRevisionSchema.parse({ serviceId: id, revision: revision.revision, config: revision.config, createdAt: revision.createdAt.getTime() }) };
            });
        },
        async readRevision(ownerId: string, id: string, revision: number): Promise<ServiceRevision> {
            const row = await database.aIServiceRevision.findFirst({ where: { serviceId: id, revision, service: { ownerId } } });
            if (!row) deny('service-not-found');
            return ServiceRevisionSchema.parse({ serviceId: id, revision, config: row.config, createdAt: row.createdAt.getTime() });
        },
        async updateServiceMetadata(ownerId: string, id: string, expectedRevision: number, input: z.infer<typeof ServiceMetadataSchema>): Promise<ServiceRef> {
            const parsed = ServiceMetadataSchema.safeParse(input);
            if (!parsed.success) deny('invalid-request');
            return database.$transaction(async tx => {
                const row = await lockService(tx, ownerId, id); requireRevision(row.revision, expectedRevision);
                const updated = await tx.aIService.update({ where: { id }, data: parsed.data });
                return ServiceRefSchema.parse({ id, ownerId, name: updated.name, enabled: updated.enabled, revision: updated.revision });
            });
        },
        async deleteService(ownerId: string, id: string, expectedRevision: number): Promise<void> {
            await database.$transaction(async tx => {
                const row = await lockService(tx, ownerId, id); requireRevision(row.revision, expectedRevision);
                await tx.aIService.update({ where: { id }, data: { enabled: false, deletedAt: new Date() } });
            });
        },
        /** Trusted T4 issuance only. This method does not authenticate a grant credential. */
        async registerAuthorization(ownerId: string, input: AuthorizationInput): Promise<ServiceGrant> {
            const parsed = AuthorizationInputSchema.safeParse(input);
            if (!parsed.success) deny('invalid-request');
            const data = parsed.data;
            return database.$transaction(async tx => {
                const service = await lockService(tx, ownerId, data.scope.serviceId);
                if (!service.enabled) deny('service-disabled');
                const policy = await createApplicationRegistry(tx).readApplication(data.scope.appId);
                if (data.scope.permissions.some(permission => !policy.capabilities.includes(permission))) deny('permission-denied');
                if (data.scope.expiresAt !== null && data.scope.expiresAt <= Date.now()) deny('authorization-expired');
                for (const target of data.scope.targets) await verifyConfig(tx, ownerId, { ...target, modelId: null, reasoning: { mode: 'default' } });
                const row = await tx.aIServiceAuthorization.create({ data: { id: data.id, ownerId, appId: data.scope.appId,
                    serviceId: data.scope.serviceId, kind: data.kind, scope: data.scope,
                    expiresAt: data.scope.expiresAt === null ? null : new Date(data.scope.expiresAt),
                    allowModelOverride: data.allowModelOverride, allowReasoningOverride: data.allowReasoningOverride } });
                return ServiceGrantSchema.parse({ id: row.id, ownerId, kind: row.kind, protocol: 'ai-services/1', scope: row.scope, createdAt: row.createdAt.getTime(), revokedAt: null });
            });
        },
        async listServiceAuthorizations(ownerId: string, serviceId: string): Promise<ServiceGrant[]> {
            return database.$transaction(async tx => {
                await lockService(tx, ownerId, serviceId);
                const rows = await tx.aIServiceAuthorization.findMany({ where: { ownerId, serviceId }, orderBy: { createdAt: 'asc' } });
                return rows.map(row => ServiceGrantSchema.parse({ id: row.id, ownerId, kind: row.kind, protocol: 'ai-services/1', scope: row.scope,
                    createdAt: row.createdAt.getTime(), revokedAt: row.revokedAt?.getTime() ?? null }));
            });
        },
        async revokeAuthorization(ownerId: string, id: string): Promise<void> {
            const result = await database.aIServiceAuthorization.updateMany({ where: { id, ownerId }, data: { revokedAt: new Date() } });
            if (result.count !== 1) deny('permission-denied');
        },
    };
}
export type AIServiceStore = ReturnType<typeof createAIServiceStore>;
