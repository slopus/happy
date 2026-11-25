import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
    AgentRolesInputSchema,
    DelegateTaskInputSchema,
    DelegatedTaskTargetInputSchema,
    DelegationRoleInputSchema,
    type DelegationResponse,
} from '@slopus/happy-wire';

export const DELEGATION_MCP_TOOL_NAMES = ['agent_roles', 'delegate_task', 'read_delegated_task', 'cancel_delegated_task'] as const;
export type DelegationMcpToolName = typeof DELEGATION_MCP_TOOL_NAMES[number];
/** The daemon's ten minute event wait expires before either MCP transport does. */
export const DELEGATION_MCP_TIMEOUT_MS = 11 * 60_000;

type Invoke = (name: DelegationMcpToolName, args: Record<string, unknown>) => Promise<CallToolResult>;

export function registerDelegationMcpTools(server: McpServer, invoke: Invoke): void {
    // Keep the JSON Schema root an object for native MCP clients. The full
    // discriminated contract is also checked in the handler before dispatch.
    server.registerTool('agent_roles', {
        title: 'Manage Delegation Roles',
        description: 'Before handling a user task that may benefit from delegation, list the configured roles reusable by this account on the current machine. Follow the user\'s explicit role/executor choice first. Without an explicit delegation request, you may select only an autoDelegate=true role whose description fits the task; autoDelegate=false requires an explicit user request. A role separates its name/description from executor, model, optional effort, and autoDelegate policy. Save/delete roles only when the user asks to create/change/remove a role: save needs a stable id; delete uses roleId. Tasks and their results remain scoped to the parent session. Prefer an observed native model code. When the user supplies a model label such as Neon, preserve that label for unique resolution against the target executor\'s actual native catalog at execution time; never invent an alias or silently substitute a default model. Never include credentials, shell commands, or environment variables. Executors use their own current accounts and independent quotas.',
        inputSchema: z.object({
            action: z.enum(['list', 'save', 'delete']),
            role: DelegationRoleInputSchema.optional(),
            roleId: DelegatedTaskTargetInputSchema.shape.taskId.optional(),
        }).strict(),
    }, async args => invoke('agent_roles', AgentRolesInputSchema.parse(args)));

    server.registerTool('delegate_task', {
        title: 'Delegate a Linked Agent Task',
        description: 'Delegate work to a saved role while keeping the current agent in control of this parent session. Supply roleId for a new task or taskId to revise that same task, never both. Include only the task requirements, verified facts, constraints, relevant source excerpts and expected output in prompt/context. Use a stable requestId for retries. The tool waits for a lifecycle outcome; progress remains visible in the parent session. If waiting times out or delivery is uncertain, retain the returned taskId and requestId: read the same task or retry the same requestId, never blindly create a replacement. A child uses a separate executor history and quota. Do not let concurrent agents write the same authoritative file; request draft text/patches and integrate them in the parent. A completed worker does not prove the parent reviewed or saved its output.',
        inputSchema: DelegateTaskInputSchema,
    }, async args => invoke('delegate_task', DelegateTaskInputSchema.parse(args)));

    server.registerTool('read_delegated_task', {
        title: 'Read a Linked Delegated Task',
        description: 'Read one current status/result snapshot of a delegated task owned by this parent session. Use an actual returned taskId, including after an uncertain wait, to recover the result or inspect an explicit user request. This is a single read; do not repeatedly query status in a loop. It cannot read arbitrary sessions or another parent\'s tasks.',
        inputSchema: DelegatedTaskTargetInputSchema,
    }, async args => invoke('read_delegated_task', DelegatedTaskTargetInputSchema.parse(args)));

    server.registerTool('cancel_delegated_task', {
        title: 'Cancel a Linked Delegated Task',
        description: 'Request cancellation of a delegated task owned by this parent session. Use the taskId returned by delegate_task. Keep draft/result history; a cancellation request is not a confirmed stop until the executor reports a terminal lifecycle. Do not silently switch executor or model on cancellation or failure.',
        inputSchema: DelegatedTaskTargetInputSchema,
    }, async args => invoke('cancel_delegated_task', DelegatedTaskTargetInputSchema.parse(args)));
}

/** Return the current artifact without copying every historical prompt/result into the parent context. */
export function delegationToolResponse(response: DelegationResponse): CallToolResult {
    const { task, ...rest } = response;
    const payload = task ? (() => {
        const { prompt: _prompt, context: _context, history, result, ...summary } = task;
        return {
            ...rest,
            task: summary,
            ...(result ? { result } : {}),
            versions: history.map(version => ({
                version: version.version, status: version.status, resultAvailable: Boolean(version.result),
                ...(version.finishedAt === undefined ? {} : { finishedAt: version.finishedAt }),
            })),
        };
    })() : rest;
    const failed = !response.success || task?.status === 'failed' || task?.status === 'interrupted';
    return {
        isError: failed,
        content: [{
            type: 'text',
            text: JSON.stringify(payload) + (task?.childSessionId
                ? '\n<happy-session>\n' + JSON.stringify({ sessionId: task.childSessionId, title: task.title }) + '\n</happy-session>'
                : ''),
        }],
    };
}
