/** Parent-scoped, locally executed cross-agent delegations. No credentials or shell configuration. */
import { z } from 'zod';

const id = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const modelCode = z.string().trim().min(1).max(256).refine(value => !/[\u0000-\u001f]/.test(value), 'Expected a model code');
const prompt = z.string().trim().min(1).max(100_000);
const context = z.string().max(100_000);

export const DelegationAgentSchema = z.enum(['codex', 'antigravity']);
export type DelegationAgent = z.infer<typeof DelegationAgentSchema>;

export const DelegationRoleInputSchema = z.object({
    id,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(10_000),
    agent: DelegationAgentSchema,
    model: modelCode,
    effort: z.string().trim().min(1).max(100).optional(),
    autoDelegate: z.boolean(),
}).strict();
export type DelegationRoleInput = z.infer<typeof DelegationRoleInputSchema>;
export const DelegationRoleSchema = DelegationRoleInputSchema.extend({ createdAt: timestamp, updatedAt: timestamp });
export type DelegationRole = z.infer<typeof DelegationRoleSchema>;

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
    roleId: id,
    roleName: z.string().trim().min(1).max(100),
    agent: DelegationAgentSchema,
    model: modelCode,
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

/** A version keeps its actual instruction and result; array position is never a version identifier. */
export const DelegatedTaskVersionSchema = z.object({
    version: z.number().int().positive(),
    requestId: id.optional(),
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
    z.object({ action: z.literal('save'), role: DelegationRoleInputSchema }).strict(),
    z.object({ action: z.literal('delete'), roleId: id }).strict(),
]);
export type AgentRolesInput = z.infer<typeof AgentRolesInputSchema>;
export const DelegateTaskInputSchema = z.object({
    requestId: id,
    title: z.string().trim().min(1).max(200).optional(),
    roleId: id.optional(),
    taskId: id.optional(),
    prompt,
    context: context.optional(),
}).strict().refine(value => Boolean(value.roleId) !== Boolean(value.taskId), {
    message: 'Supply roleId for a new task, or taskId to revise the same task; never both',
});
export type DelegateTaskInput = z.infer<typeof DelegateTaskInputSchema>;
export const DelegatedTaskTargetInputSchema = z.object({ taskId: id }).strict();
export type DelegatedTaskTargetInput = z.infer<typeof DelegatedTaskTargetInputSchema>;

export const DelegationRequestSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('roles-list'), parentSessionId: id }).strict(),
    z.object({ action: z.literal('roles-save'), parentSessionId: id, role: DelegationRoleInputSchema }).strict(),
    z.object({ action: z.literal('roles-delete'), parentSessionId: id, roleId: id }).strict(),
    DelegateTaskInputSchema.safeExtend({ action: z.literal('start'), parentSessionId: id, wait: z.boolean().optional() }),
    z.object({ action: z.literal('read'), parentSessionId: id, taskId: id }).strict(),
    z.object({ action: z.literal('cancel'), parentSessionId: id, taskId: id }).strict(),
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

/** Waiting for input is recoverable and returns control to the parent instead of keeping an MCP call open. */
export function isDelegatedTaskSettled(status: DelegatedTaskStatus): boolean {
    return !['starting', 'running'].includes(status);
}
