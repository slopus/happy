import { Buffer } from 'node:buffer';
import { AgentRolesInputSchema, DelegationRoleSchema, type AgentRolesInput, type DelegationRole, type McpAppResultV1 } from '@slopus/happy-wire';

const MAX_RECEIPT_BYTES = 64 * 1024;
export type RoleSaveInput = Extract<AgentRolesInput, { action: 'create' | 'update' }>;
/** Called before the actual request, so the consumer can fence its completion
 * to the original session/turn. Observer failures never change the mutation. */
export type RoleSaveObserver = (parentSessionId: string, request: RoleSaveInput) =>
    ((role: DelegationRole) => void | Promise<void>) | undefined;
function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function decode(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    if (Buffer.byteLength(value, 'utf8') > MAX_RECEIPT_BYTES) return null;
    try { return JSON.parse(value); } catch { return null; }
}
function failed(value: Record<string, unknown>) {
    return value.isError === true || !!value.error || (typeof value.status === 'string'
        && ['failed', 'cancelled', 'canceled', 'denied'].includes(value.status));
}

export function boundedRoleSaveInput(input: unknown, acp = false): RoleSaveInput | undefined {
    let candidate = record(input);
    if (!candidate) return undefined;
    // AGY decorates its native event, but never the real MCP arguments. Strip
    // only this exact known display field; all other unknown keys stay invalid.
    if (acp && Object.hasOwn(candidate, 'toolSummary')) {
        if (typeof candidate.toolSummary !== 'string' || candidate.toolSummary.length > 1000) return undefined;
        const { toolSummary: _summary, ...args } = candidate;
        candidate = args;
    }
    const request = AgentRolesInputSchema.safeParse(candidate);
    if (!request.success || (request.data.action !== 'create' && request.data.action !== 'update')) return undefined;
    return Buffer.byteLength(JSON.stringify(request.data), 'utf8') <= MAX_RECEIPT_BYTES ? request.data : undefined;
}

export function roleFromSaveReceipt(receipt: McpAppResultV1 | undefined): DelegationRole | undefined {
    if (receipt?.state !== 'available') return undefined;
    const payload = record(receipt.structuredContent);
    const role = payload?.success === true ? DelegationRoleSchema.safeParse(payload.role) : undefined;
    return role?.success ? role.data : undefined;
}

/** Exact identities emitted by our injected `happy` MCP server. A bare
 * agent_roles name or an arbitrary title cannot establish server ownership. */
export function isHappyRoleTool(name: string, title?: string) {
    return ['mcp__happy__agent_roles', 'mcp_happy_agent_roles', 'happy__agent_roles'].includes(name)
        || (name === 'other' && title === 'Run mcp_happy_agent_roles');
}

/** Carry only a validated saved-role receipt through the existing MCP result
 * channel. Never forward a machine directory, arbitrary tool output or prose. */
export function roleSaveReceipt(server: string, tool: string, input: unknown, rawResult: unknown): McpAppResultV1 | undefined {
    if (server !== 'happy' || tool !== 'agent_roles') return undefined;
    const request = AgentRolesInputSchema.safeParse(decode(input));
    if (!request.success || (request.data.action !== 'create' && request.data.action !== 'update')) return undefined;
    let value = decode(rawResult);
    // MCP CallToolResult or the single standard ACP ToolCallContent block.
    // These are fixed wrappers, not a recursive search through assistant text.
    for (let depth = 0; depth < 5; depth++) {
        if (Array.isArray(value)) {
            if (value.length !== 1) return undefined;
            const block = record(value[0]);
            if (block?.type === 'text') value = decode(block.text);
            else if (block?.type === 'content' && record(block.content)?.type === 'text') value = decode(record(block.content)!.text);
            else return undefined;
            continue;
        }
        const object = record(value);
        if (!object || failed(object)) return undefined;
        if (object.success === true) {
            const role = DelegationRoleSchema.safeParse(object.role);
            if (!role.success) return undefined;
            const expectedId = request.data.action === 'update' ? request.data.roleId : request.data.role.id;
            if (expectedId !== undefined && expectedId !== role.data.id) return undefined;
            const structuredContent = { success: true, role: role.data };
            if (Buffer.byteLength(JSON.stringify(structuredContent), 'utf8') > MAX_RECEIPT_BYTES) return undefined;
            return { version: 1, state: 'available', content: [], structuredContent };
        }
        if (!Array.isArray(object.content)) return undefined;
        value = object.content;
    }
    return undefined;
}
