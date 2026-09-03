/**
 * Formats Codex events for normal logs while keeping MCP App payloads inside
 * the encrypted session boundary.
 */

const MCP_EVENT_TYPES = new Set([
    'mcp_tool_call_begin',
    'mcp_tool_call_end',
]);

const MCP_EVENT_STATUSES = new Set([
    'inProgress',
    'completed',
    'failed',
    'cancelled',
    'canceled',
    'aborted',
    'interrupted',
]);

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function formatCodexEventForLog(event: Record<string, unknown>): string {
    if (!MCP_EVENT_TYPES.has(event.type as string)) {
        return `[Codex] Event: ${JSON.stringify(event)}`;
    }

    const type = event.type as string;
    const callId = nonEmptyString(event.call_id) ?? nonEmptyString(event.callId);
    const itemId = nonEmptyString(event.item_id);
    const status = MCP_EVENT_STATUSES.has(event.status as string)
        ? event.status as string
        : undefined;
    const safeEvent = {
        type,
        ...(callId ? { call_id: callId } : {}),
        ...(itemId ? { item_id: itemId } : {}),
        ...(status ? { status } : {}),
    };
    return `[Codex] Event: ${JSON.stringify(safeEvent)}`;
}
