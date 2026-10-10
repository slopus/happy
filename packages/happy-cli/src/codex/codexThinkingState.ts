const activityEvents = new Set([
    'agent_message', 'agent_reasoning', 'agent_reasoning_delta',
    'exec_command_begin', 'exec_command_end',
    'mcp_tool_call_begin', 'mcp_tool_call_end',
    'patch_apply_begin', 'patch_apply_end',
]);

/** Content can resume after task_complete without an intervening task_started. */
export function nextCodexThinkingState(
    thinking: boolean,
    eventType: unknown,
    isSubagentScopedEvent: boolean,
): boolean {
    if (eventType === 'task_complete' || eventType === 'turn_aborted') return false;
    if (eventType === 'task_started') return true;
    if (!isSubagentScopedEvent && typeof eventType === 'string' && activityEvents.has(eventType)) return true;
    return thinking;
}
