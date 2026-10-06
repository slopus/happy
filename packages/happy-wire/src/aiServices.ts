import { z } from 'zod';

export const AI_SERVICES_PROTOCOL = 'ai-services/1' as const;
export const AIServiceProtocolSchema = z.literal(AI_SERVICES_PROTOCOL);
export type AIServiceProtocol = z.infer<typeof AIServiceProtocolSchema>;

const IdentifierSchema = z.string().min(1).max(256).refine(value => value.trim().length > 0);
const TimestampSchema = z.number().int().nonnegative();
const RevisionSchema = z.number().int().positive();

export const ServiceEngineSchema = z.enum(['codex', 'claude']);
export type ServiceEngine = z.infer<typeof ServiceEngineSchema>;
export const CodexAccountRefSchema = z.object({ kind: z.literal('codex-profile'), id: IdentifierSchema }).strict();
export const DeviceIdentityRefSchema = z.object({
    kind: z.literal('device-identity'), machineId: IdentifierSchema, identityId: IdentifierSchema,
}).strict();
export const ServiceAccountRefSchema = z.discriminatedUnion('kind', [CodexAccountRefSchema, DeviceIdentityRefSchema]);
export type ServiceAccountRef = z.infer<typeof ServiceAccountRefSchema>;

export const ServiceReasoningSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('default') }).strict(),
    z.object({ mode: z.literal('explicit'), value: IdentifierSchema }).strict(),
]);
export type ServiceReasoning = z.infer<typeof ServiceReasoningSchema>;

/** Tools require an explicit application capability and an explicit scoped grant. */
export const ServicePermissionSchema = z.enum(['chat', 'images', 'tools']);
export type ServicePermission = z.infer<typeof ServicePermissionSchema>;
export const ServicePermissionsSchema = z.array(ServicePermissionSchema).min(1).max(3)
    .refine(values => new Set(values).size === values.length, 'permissions must be unique');

const CodexTargetSchema = z.object({
    machineId: IdentifierSchema, engine: z.literal('codex'), accountRef: CodexAccountRefSchema,
}).strict();
const ClaudeTargetSchema = z.object({
    machineId: IdentifierSchema, engine: z.literal('claude'), accountRef: DeviceIdentityRefSchema,
}).strict();
function matchesDeviceIdentity(value: { machineId: string; accountRef: ServiceAccountRef }): boolean {
    return value.accountRef.kind !== 'device-identity' || value.accountRef.machineId === value.machineId;
}

/** Each target is one approved device, engine and account tuple. */
export const ServiceTargetSchema = z.discriminatedUnion('engine', [CodexTargetSchema, ClaudeTargetSchema])
    .refine(matchesDeviceIdentity, { message: 'account identity belongs to another device', path: ['accountRef', 'machineId'] });
export type ServiceTarget = z.infer<typeof ServiceTargetSchema>;

export const ServicePermissionModeSchema = z.enum(['chat-only', 'read-only', 'yolo']);
export type ServicePermissionMode = z.infer<typeof ServicePermissionModeSchema>;
export const ServiceTierSchema = z.enum(['default', 'fast']);
export type ServiceTier = z.infer<typeof ServiceTierSchema>;
const executionOptions = { permissionMode: ServicePermissionModeSchema.optional(), serviceTier: ServiceTierSchema.optional() };
const configFields = { modelId: IdentifierSchema.nullable(), reasoning: ServiceReasoningSchema, ...executionOptions };
export const ServiceConfigSchema = z.discriminatedUnion('engine', [
    CodexTargetSchema.extend(configFields).strict(), ClaudeTargetSchema.extend(configFields).strict(),
]).refine(matchesDeviceIdentity, { message: 'account identity belongs to another device', path: ['accountRef', 'machineId'] });
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

export const ServiceRefSchema = z.object({
    id: IdentifierSchema, ownerId: IdentifierSchema, name: IdentifierSchema,
    enabled: z.boolean(), revision: RevisionSchema,
}).strict();
export type ServiceRef = z.infer<typeof ServiceRefSchema>;

/** Safe, scoped configuration metadata. It contains no credentials or execution paths. */
export const ServiceConfigurationSchema = z.object({
    service: ServiceRefSchema, defaults: ServiceConfigSchema,
    targets: z.array(z.object({ target: ServiceTargetSchema, machineName: IdentifierSchema, accountName: IdentifierSchema }).strict()).min(1).max(64),
    permissions: ServicePermissionsSchema,
}).strict();
export type ServiceConfiguration = z.infer<typeof ServiceConfigurationSchema>;

export const ServiceRevisionSchema = z.object({
    serviceId: IdentifierSchema, revision: RevisionSchema, config: ServiceConfigSchema, createdAt: TimestampSchema,
}).strict();
export type ServiceRevision = z.infer<typeof ServiceRevisionSchema>;

const bindingFields = {
    id: IdentifierSchema, appId: IdentifierSchema, serviceId: IdentifierSchema, revision: RevisionSchema,
    requestedModel: IdentifierSchema.nullable(), reasoning: ServiceReasoningSchema, permissions: ServicePermissionsSchema, ...executionOptions,
};
/** A binding fixes identity, not the current authentication token. Null requests the runtime default. */
export const ExecutionBindingSchema = z.discriminatedUnion('engine', [
    CodexTargetSchema.extend(bindingFields).strict(), ClaudeTargetSchema.extend(bindingFields).strict(),
]).refine(matchesDeviceIdentity, { message: 'account identity belongs to another device', path: ['accountRef', 'machineId'] });
export type ExecutionBinding = z.infer<typeof ExecutionBindingSchema>;

export const ModelReasoningCapabilitySchema = z.object({
    supportsDefault: z.boolean(), values: z.array(IdentifierSchema).max(64), defaultValue: IdentifierSchema.nullable(),
}).strict().refine(value => value.defaultValue === null || value.values.includes(value.defaultValue),
    { message: 'reasoning default must be a native value', path: ['defaultValue'] });
export type ModelReasoningCapability = z.infer<typeof ModelReasoningCapabilitySchema>;
export const ServiceModelCapabilitySchema = z.object({
    id: IdentifierSchema, name: IdentifierSchema, supportsImages: z.boolean(), reasoning: ModelReasoningCapabilitySchema,
    serviceTiers: z.array(ServiceTierSchema).max(2).optional(),
}).strict();
export type ServiceModelCapability = z.infer<typeof ServiceModelCapabilitySchema>;

const catalogFields = {
    protocol: AIServiceProtocolSchema, observedAt: TimestampSchema,
    availability: z.enum(['online', 'offline']), completeness: z.enum(['complete', 'limited']),
    models: z.array(ServiceModelCapabilitySchema).max(1024), defaultModelId: IdentifierSchema.nullable(),
    execution: z.object({ permissionModes: z.array(ServicePermissionModeSchema).min(1).max(3), serviceTiers: z.array(ServiceTierSchema).min(1).max(2) }).strict().optional(),
};
/** Offline observations are display data. Execution requires a new capability check. */
export const CapabilityCatalogSchema = z.discriminatedUnion('engine', [
    CodexTargetSchema.extend(catalogFields).strict(), ClaudeTargetSchema.extend(catalogFields).strict(),
]).refine(matchesDeviceIdentity, { message: 'account identity belongs to another device', path: ['accountRef', 'machineId'] });
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;

export const ServiceErrorCodeSchema = z.enum([
    'authorization-expired', 'authorization-revoked', 'machine-offline', 'account-login-required',
    'account-identity-changed', 'account-not-found', 'service-not-found', 'service-disabled',
    'model-unavailable', 'parameter-unsupported', 'quota-exhausted', 'execution-interrupted',
    'protocol-incompatible', 'consent-required', 'revision-conflict', 'permission-denied',
    'invalid-service-config', 'invalid-request', 'resource-busy', 'internal-error',
]);
export type ServiceErrorCode = z.infer<typeof ServiceErrorCodeSchema>;
/** Clients map codes to safe messages. Raw upstream messages and logs are excluded. */
export const ServiceErrorSchema = z.object({ code: ServiceErrorCodeSchema, retryable: z.boolean() }).strict();
export type ServiceError = z.infer<typeof ServiceErrorSchema>;

export const TerminalTurnStatusSchema = z.enum(['completed', 'failed', 'cancelled', 'interrupted']);
export type TerminalTurnStatus = z.infer<typeof TerminalTurnStatusSchema>;
export const TurnStatusSchema = z.enum(['accepted', 'running', 'cancel-requested', ...TerminalTurnStatusSchema.options]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;
/** Null means the executor did not report the value. Requested values are never substituted. */
export const TurnActualSchema = z.object({ modelId: IdentifierSchema.nullable(), reasoning: IdentifierSchema.nullable(), permissionMode: ServicePermissionModeSchema.nullable().optional(), serviceTier: IdentifierSchema.nullable().optional() }).strict();
export type TurnActual = z.infer<typeof TurnActualSchema>;

const TurnRecordObjectSchema = z.object({
    id: IdentifierSchema, conversationId: IdentifierSchema, requestId: IdentifierSchema,
    binding: ExecutionBindingSchema, status: TurnStatusSchema, actual: TurnActualSchema,
    createdAt: TimestampSchema, startedAt: TimestampSchema.nullable(), completedAt: TimestampSchema.nullable(),
    error: ServiceErrorSchema.nullable(),
}).strict();
function hasValidTurnState(value: { status: TurnStatus; completedAt: number | null; error: ServiceError | null }): boolean {
    const terminal = TerminalTurnStatusSchema.safeParse(value.status).success;
    if (terminal !== (value.completedAt !== null)) return false;
    if (value.status === 'failed' || value.status === 'interrupted') return value.error !== null;
    if (value.status === 'cancelled') return true;
    return value.error === null;
}
export const TurnRecordSchema = TurnRecordObjectSchema.refine(hasValidTurnState, 'inconsistent turn state');
export type TurnRecord = z.infer<typeof TurnRecordSchema>;
export const TurnResultSchema = TurnRecordObjectSchema.extend({
    status: TerminalTurnStatusSchema, completedAt: TimestampSchema,
}).strict().refine(hasValidTurnState, 'inconsistent turn state');
export type TurnResult = z.infer<typeof TurnResultSchema>;

const OriginSchema = z.string().max(2048).refine(value => {
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && url.origin === value;
    } catch { return false; }
}, 'must be an exact HTTP origin');
export const BusinessPromptRefSchema = z.object({ id: IdentifierSchema, version: IdentifierSchema }).strict();
export type BusinessPromptRef = z.infer<typeof BusinessPromptRefSchema>;
/** Owner-managed registry data only. This schema is not a client registration API. */
export const AppPolicySchema = z.object({
    appId: IdentifierSchema, name: IdentifierSchema, origins: z.array(OriginSchema).min(1).max(32),
    capabilities: ServicePermissionsSchema, businessPrompt: BusinessPromptRefSchema,
}).strict();
export type AppPolicy = z.infer<typeof AppPolicySchema>;

export const ServiceGrantScopeSchema = z.object({
    appId: IdentifierSchema, serviceId: IdentifierSchema, targets: z.array(ServiceTargetSchema).min(1).max(64),
    permissions: ServicePermissionsSchema, expiresAt: TimestampSchema.nullable(),
}).strict();
export type ServiceGrantScope = z.infer<typeof ServiceGrantScopeSchema>;
export const ServiceGrantKindSchema = z.enum(['platform-grant', 'personal-grant']);
export type ServiceGrantKind = z.infer<typeof ServiceGrantKindSchema>;
const principalFields = { ownerId: IdentifierSchema, grantId: IdentifierSchema, scope: ServiceGrantScopeSchema };
export const ServicePrincipalSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('owner'), ownerId: IdentifierSchema }).strict(),
    z.object({ kind: z.literal('platform-grant'), ...principalFields }).strict(),
    z.object({ kind: z.literal('personal-grant'), ...principalFields }).strict(),
]);
export type ServicePrincipal = z.infer<typeof ServicePrincipalSchema>;

/** Safe metadata for later reads. It has no credential or message key fields. */
export const ServiceGrantSchema = z.object({
    id: IdentifierSchema, ownerId: IdentifierSchema, kind: ServiceGrantKindSchema, protocol: AIServiceProtocolSchema,
    scope: ServiceGrantScopeSchema, createdAt: TimestampSchema, revokedAt: TimestampSchema.nullable(),
}).strict();
export type ServiceGrant = z.infer<typeof ServiceGrantSchema>;
/** Returned once at issuance. Later endpoints must use ServiceGrant instead. */
export const GrantReceiptSchema = ServiceGrantSchema.extend({
    credential: z.string().min(1).max(4096), messageKey: z.string().min(1).max(4096),
}).strict();
export type GrantReceipt = z.infer<typeof GrantReceiptSchema>;

export function parseServiceConfig(value: unknown): ServiceConfig {
    const result = ServiceConfigSchema.safeParse(value);
    if (!result.success) throw new Error('invalid-service-config');
    return result.data;
}
export function parseTurnRecord(value: unknown): TurnRecord {
    const result = TurnRecordSchema.safeParse(value);
    if (!result.success) throw new Error('invalid-turn-record');
    return result.data;
}
export function parseTurnResult(value: unknown): TurnResult {
    const result = TurnResultSchema.safeParse(value);
    if (!result.success) throw new Error('invalid-turn-result');
    return result.data;
}
