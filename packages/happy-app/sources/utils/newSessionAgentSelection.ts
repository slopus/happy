import type { NewSessionAgentType } from '@/sync/persistence';

export const NEW_SESSION_AGENT_ORDER: readonly NewSessionAgentType[] = [
    'claude',
    'codex',
    'openclaw',
    'gemini',
    'agy',
];

type CliAvailability = Partial<Record<NewSessionAgentType, boolean>>;

/**
 * Keep the persisted selection when it is still installed. If it is stale,
 * use the first CLI the selected machine actually reports as available.
 * Older machines without capability metadata retain the persisted selection.
 */
export function resolveMachineAgent(
    selectedAgent: NewSessionAgentType,
    availability: CliAvailability | null | undefined,
): NewSessionAgentType {
    if (!availability || availability[selectedAgent]) {
        return selectedAgent;
    }

    return NEW_SESSION_AGENT_ORDER.find((agent) => availability[agent]) ?? selectedAgent;
}
