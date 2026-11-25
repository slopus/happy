import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
    AgentRolesInputSchema,
    DelegateTaskToolInputSchema,
    DelegatedTaskTargetInputSchema,
    DelegationRoleCreateInputSchema,
    DelegationRolePatchSchema,
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
        description: 'List the configured roles reusable by this account on the current machine before choosing automatic delegation. Create/update/delete roles only when the user asks; creation never executes a task. create accepts an optional stable id (otherwise one is generated) and defaults autoDelegate=false; update requires the exact existing roleId and patch, and cannot change its ID; delete uses roleId. Never guess a role ID from its name. save is legacy upsert compatibility only; prefer create/update. Model and effort may be omitted to use the target native defaults, or supplied as native codes/uniquely advertised labels such as Neon and High. Never invent a model alias or silently substitute another model. Settings and these tools use the same role store. Never include credentials, shell commands or environment variables.',
        inputSchema: z.object({
            action: z.enum(['list', 'create', 'update', 'save', 'delete']),
            role: DelegationRoleCreateInputSchema.optional(),
            roleId: DelegatedTaskTargetInputSchema.shape.taskId.optional(),
            patch: DelegationRolePatchSchema.optional(),
        }).strict(),
    }, async args => invoke('agent_roles', AgentRolesInputSchema.parse(args)));

    server.registerTool('delegate_task', {
        title: 'Delegate a Linked Agent Task',
        description: 'Keep the current agent in control and supply exactly one of roleId (saved role), taskId (revise the same live worker/history), or route {agent, model?, effort?} for a one-off task without saving a role. Always classify intent: automatic requires a saved role whose autoDelegate is true and whose description fits the work; explicit means the user actually requested this delegation. Intent is your classification, not proof of separately collected human approval. Never mark an automatic choice explicit to bypass the role policy. Temporary routes and revisions require explicit intent. Follow the user\'s current executor/model choice first. Omitted model/effort use the target native defaults, not this parent\'s model or reasoning effort. Include task requirements, verified facts, constraints, context and expected output. Use a stable requestId for retries. The tool waits for an outcome; retain taskId/requestId after uncertainty and never create a replacement blindly. Do not let concurrent agents write the same authoritative file; ask for drafts/patches and review before integrating. A worker finishing does not prove parent review or file save.',
        inputSchema: DelegateTaskToolInputSchema,
    }, async args => invoke('delegate_task', DelegateTaskToolInputSchema.parse(args)));

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
                version: version.version, status: version.status, intent: version.intent, resultAvailable: Boolean(version.result),
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
