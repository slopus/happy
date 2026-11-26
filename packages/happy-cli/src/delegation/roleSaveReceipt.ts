import { Buffer } from 'node:buffer';
import { AgentRolesInputSchema, DelegationRoleSchema, type McpAppResultV1 } from '@slopus/happy-wire';

const MAX_RECEIPT_BYTES = 64 * 1024;
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
