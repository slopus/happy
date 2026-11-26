import { DelegationRoleSchema, type DelegationRole } from '@slopus/happy-wire';
import type { ToolCall } from '@/sync/typesMessage';

// A role tool may return the full machine directory. Bound JSON decoding, and
// inspect only the direct response or its one MCP text block, never prose.
const MAX_RESULT_LENGTH = 2 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

function decode(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    if (value.length > MAX_RESULT_LENGTH) return null;
    try { return JSON.parse(value); } catch { return null; }
}

/** A successful saved-role receipt, not a directory read or assistant claim. */
export function readAgentRoleResult(tool: Pick<ToolCall, 'name' | 'state' | 'input' | 'result' | 'permission' | 'mcpAppResult'>): DelegationRole | null {
    if (tool.state !== 'completed'
        || tool.permission?.status === 'denied' || tool.permission?.status === 'canceled') return null;
    const wrapped = record(decode(tool.input));
    const native = tool.name === 'McpTool' && wrapped?.server === 'happy' && wrapped.tool === 'agent_roles';
    if (!native && tool.name !== 'agent_roles' && tool.name !== 'mcp__happy__agent_roles') return null;
    const input = native ? record(decode(wrapped?.arguments)) : wrapped;
    if (!input || (input.action !== 'create' && input.action !== 'update')) return null;
    const nativeResult = tool.mcpAppResult?.state === 'available' ? tool.mcpAppResult : null;
    let response = record(decode(nativeResult?.structuredContent ?? nativeResult ?? tool.result));
    if (!response || response.isError === true) return null;
    if (response.success === undefined) {
        const content = response.content;
        if (!Array.isArray(content) || content.length !== 1) return null;
        const block = record(content[0]);
        if (!block || block.type !== 'text') return null;
        response = record(decode(block.text));
    }
    if (!response || response.success !== true || response.isError === true) return null;
    const parsed = DelegationRoleSchema.safeParse(response.role);
    if (!parsed.success) return null;
    const expectedId = input.action === 'update' ? input.roleId : record(input.role)?.id;
    if (input.action === 'update' && typeof expectedId !== 'string') return null;
    if (expectedId !== undefined && expectedId !== parsed.data.id) return null;
    return parsed.data;
}
