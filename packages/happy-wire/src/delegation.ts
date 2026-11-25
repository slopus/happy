/** Parent-scoped, locally executed cross-agent delegations. No credentials or shell configuration. */
import { z } from 'zod';

const id = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const modelCode = z.string().trim().min(1).max(256).refine(value => !/[\u0000-\u001f]/.test(value), 'Expected a model code');
const prompt = z.string().trim().min(1).max(100_000);
const context = z.string().max(100_000);

export const DelegationAgentSchema = z.enum(['codex', 'antigravity']);
export type DelegationAgent = z.infer<typeof DelegationAgentSchema>;
const effortCode = z.string().trim().min(1).max(100);
/** Omission means the target executor's observed native default, never the parent's route. */
export const DelegationRouteSchema = z.object({
    agent: DelegationAgentSchema,
    model: modelCode.optional(),
    effort: effortCode.optional(),
}).strict();
export type DelegationRoute = z.infer<typeof DelegationRouteSchema>;
export const DelegationIntentSchema = z.enum(['explicit', 'automatic']);

export const DelegationRoleInputSchema = z.object({
    id,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(10_000),
    agent: DelegationAgentSchema,
    model: modelCode.optional(),
    effort: effortCode.optional(),
    autoDelegate: z.boolean(),
}).strict();
export type DelegationRoleInput = z.infer<typeof DelegationRoleInputSchema>;
export const DelegationRoleSchema = DelegationRoleInputSchema.extend({ createdAt: timestamp, updatedAt: timestamp });
export type DelegationRole = z.infer<typeof DelegationRoleSchema>;
export const DelegationRoleCreateInputSchema = DelegationRoleInputSchema.extend({
    id: id.optional(),
    autoDelegate: z.boolean().default(false),
});
export type DelegationRoleCreateInput = z.input<typeof DelegationRoleCreateInputSchema>;
export const DelegationRolePatchSchema = DelegationRoleInputSchema.omit({ id: true }).partial().extend({
    model: modelCode.nullable().optional(),
    effort: effortCode.nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Supply at least one role field to update');
export type DelegationRolePatch = z.infer<typeof DelegationRolePatchSchema>;

/** Machine-scoped role configuration, authenticated by the machine RPC transport. It never dispatches work. */
export const MachineDelegationRolesRequestSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list') }).strict(),
    z.object({ action: z.literal('create'), role: DelegationRoleCreateInputSchema }).strict(),
    z.object({ action: z.literal('update'), roleId: id, patch: DelegationRolePatchSchema }).strict(),
    z.object({ action: z.literal('delete'), roleId: id }).strict(),
]);
export type MachineDelegationRolesRequest = z.input<typeof MachineDelegationRolesRequestSchema>;

export const DelegatedTaskStatusSchema = z.enum([
    'starting', 'running', 'waiting-for-input', 'completed', 'failed', 'cancelled', 'interrupted',
]);
export type DelegatedTaskStatus = z.infer<typeof DelegatedTaskStatusSchema>;
export const DelegatedTaskResultSchema = z.object({
    text: z.string().max(200_000),
    truncated: z.boolean().optional(),
    turnId: modelCode.optional(),
}).strict();
export type DelegatedTaskResult = z.infer<typeof DelegatedTaskResultSchema>;

export const DelegatedTaskSummarySchema = z.object({
    id,
    parentSessionId: id,
    childSessionId: id.optional(),
    title: z.string().trim().min(1).max(200),
    roleId: id.optional(),
    roleName: z.string().trim().min(1).max(100),
    agent: DelegationAgentSchema,
    model: modelCode.optional(),
    effort: z.string().trim().min(1).max(100).optional(),
    version: z.number().int().positive(),
    status: DelegatedTaskStatusSchema,
    startedAt: timestamp,
    updatedAt: timestamp,
    finishedAt: timestamp.optional(),
    error: z.string().max(4_000).optional(),
    resultAvailable: z.boolean(),
    cancelRequested: z.boolean().optional(),
}).strict();
export type DelegatedTaskSummary = z.infer<typeof DelegatedTaskSummarySchema>;
/** Keep legacy metadata envelopes readable by clients whose known fields require these values. */
export const DelegationRoleV1Schema = DelegationRoleSchema.extend({ model: modelCode });
export const DelegatedTaskSummaryV1Schema = DelegatedTaskSummarySchema.extend({ roleId: id, model: modelCode });
export const DelegationSnapshotV2Schema = z.object({
    version: z.literal(2),
    roles: z.array(DelegationRoleSchema).max(100),
    tasks: z.array(DelegatedTaskSummarySchema).max(100),
}).strict();
export type DelegationSnapshotV2 = z.infer<typeof DelegationSnapshotV2Schema>;

/** A version keeps its actual instruction and result; array position is never a version identifier. */
export const DelegatedTaskVersionSchema = z.object({
    version: z.number().int().positive(),
    requestId: id.optional(),
    intent: z.enum(['explicit', 'automatic', 'legacy-explicit']).optional(),
    prompt,
    context: context.optional(),
    status: DelegatedTaskStatusSchema,
    startedAt: timestamp,
    updatedAt: timestamp,
    finishedAt: timestamp.optional(),
    error: z.string().max(4_000).optional(),
    result: DelegatedTaskResultSchema.optional(),
}).strict();
export type DelegatedTaskVersion = z.infer<typeof DelegatedTaskVersionSchema>;
export const DelegatedTaskSchema = DelegatedTaskSummarySchema.extend({
    prompt,
    context: context.optional(),
    history: z.array(DelegatedTaskVersionSchema).max(100),
    result: DelegatedTaskResultSchema.optional(),
});
export type DelegatedTask = z.infer<typeof DelegatedTaskSchema>;

/** Public tool inputs intentionally omit parentSessionId; the authenticated session supplies it. */
export const AgentRolesInputSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list') }).strict(),
    z.object({ action: z.literal('create'), role: DelegationRoleCreateInputSchema }).strict(),
    z.object({ action: z.literal('update'), roleId: id, patch: DelegationRolePatchSchema }).strict(),
    // Compatibility only: new callers use create/update so an absent ID cannot silently become an upsert.
    z.object({ action: z.literal('save'), role: DelegationRoleInputSchema }).strict(),
    z.object({ action: z.literal('delete'), roleId: id }).strict(),
]);
export type AgentRolesInput = z.infer<typeof AgentRolesInputSchema>;
export const DelegateTaskInputSchema = z.object({
    requestId: id,
    title: z.string().trim().min(1).max(200).optional(),
    roleId: id.optional(),
    taskId: id.optional(),
    route: DelegationRouteSchema.optional(),
    // Legacy API requests omit intent. New MCP tools require this classification explicitly.
    intent: DelegationIntentSchema.optional(),
    prompt,
    context: context.optional(),
}).strict().refine(value => [value.roleId, value.taskId, value.route].filter(Boolean).length === 1, {
    message: 'Supply exactly one of roleId, taskId, or a temporary route',
});
export type DelegateTaskInput = z.infer<typeof DelegateTaskInputSchema>;
/** explicit is the caller's intent classification, not a claim of separately collected human approval. */
export const DelegateTaskToolInputSchema = DelegateTaskInputSchema.safeExtend({ intent: DelegationIntentSchema })
    .refine(value => value.intent !== 'automatic' || Boolean(value.roleId), 'Automatic delegation requires a saved role; temporary routes and revisions require explicit intent');
export const DelegatedTaskTargetInputSchema = z.object({ taskId: id }).strict();
export type DelegatedTaskTargetInput = z.infer<typeof DelegatedTaskTargetInputSchema>;

/** Client response version is independent from a live worker's execution capabilities. Omission remains V1. */
const delegationRequestScope = { parentSessionId: id, protocolVersion: z.literal(2).optional() };
export const DelegationRequestSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('roles-list'), ...delegationRequestScope }).strict(),
    z.object({ action: z.literal('roles-create'), ...delegationRequestScope, role: DelegationRoleCreateInputSchema }).strict(),
    z.object({ action: z.literal('roles-update'), ...delegationRequestScope, roleId: id, patch: DelegationRolePatchSchema }).strict(),
    z.object({ action: z.literal('roles-save'), ...delegationRequestScope, role: DelegationRoleInputSchema }).strict(),
    z.object({ action: z.literal('roles-delete'), ...delegationRequestScope, roleId: id }).strict(),
    DelegateTaskInputSchema.safeExtend({ action: z.literal('start'), ...delegationRequestScope, wait: z.boolean().optional() }),
    z.object({ action: z.literal('read'), ...delegationRequestScope, taskId: id }).strict(),
    z.object({ action: z.literal('cancel'), ...delegationRequestScope, taskId: id }).strict(),
]);
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;
export type DelegationAction = DelegationRequest extends infer Request
    ? Request extends { parentSessionId: string } ? Omit<Request, 'parentSessionId'> : never
    : never;
export const DelegationResponseSchema = z.object({
    success: z.boolean(),
    roles: z.array(DelegationRoleSchema).max(100).optional(),
    role: DelegationRoleSchema.optional(),
    task: DelegatedTaskSchema.optional(),
    taskId: id.optional(),
    error: z.string().max(4_000).optional(),
    waitTimedOut: z.boolean().optional(),
}).strict();
export type DelegationResponse = z.infer<typeof DelegationResponseSchema>;
export const MachineDelegationRolesResponseSchema = DelegationResponseSchema;
export type MachineDelegationRolesResponse = DelegationResponse;

/** Waiting for input is recoverable and returns control to the parent instead of keeping an MCP call open. */
export function isDelegatedTaskSettled(status: DelegatedTaskStatus): boolean {
    return !['starting', 'running'].includes(status);
}
