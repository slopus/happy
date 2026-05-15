import type { NewSessionAgentType } from '@/sync/persistence';

export interface AgentEntry {
    key: NewSessionAgentType;
    label: string;
}

/**
 * Resolves which agent to display in the new-session picker.
 *
 * Returns `storedPreference` if it is present in `availableAgents`.
 * Otherwise falls back to `availableAgents[0]` (first available in ALL_AGENTS order),
 * or `allAgents[0]` as a last resort.
 *
 * IMPORTANT: callers must treat the returned value as display-only when it differs from
 * `storedPreference`. The return value must NOT be written back to the draft store (MMKV)
 * when it was produced by a fallback — doing so would permanently corrupt the user's stored
 * preference (that was the original bug).
 */
export function resolveDisplayAgent(
    storedPreference: NewSessionAgentType,
    availableAgents: AgentEntry[],
    allAgents: AgentEntry[],
): NewSessionAgentType {
    if (availableAgents.find(a => a.key === storedPreference)) {
        return storedPreference;
    }
    return availableAgents[0]?.key ?? allAgents[0]?.key ?? 'claude';
}
