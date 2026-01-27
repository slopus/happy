import type { AgentId } from './registryCore';
import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor } from './registryCore';

export function resolveAgentIdOrDefault(
    flavor: string | null | undefined,
    fallback: AgentId,
): AgentId {
    return resolveAgentIdFromFlavor(flavor) ?? fallback;
}

/**
 * Permission prompts can arrive without reliable `metadata.flavor`, especially when
 * older daemons/agents emit tool names that encode the agent (e.g. `CodexBash`).
 *
 * This helper centralizes those heuristics.
 */
export function resolveAgentIdForPermissionUi(params: {
    flavor: string | null | undefined;
    toolName: string;
}): AgentId {
    const byFlavor = resolveAgentIdFromFlavor(params.flavor);
    if (byFlavor) return byFlavor;

    const byTool = typeof params.toolName === 'string' ? params.toolName.trim() : '';
    if (byTool.startsWith('Codex')) return 'codex';
    return DEFAULT_AGENT_ID;
}
