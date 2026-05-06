import type { NewSessionAgentType } from '@/sync/persistence';
import type { MachineMetadata } from '@/sync/storageTypes';

export type AgentKey = NewSessionAgentType;

export const ALL_AGENTS: { key: AgentKey; label: string }[] = [
    { key: 'claude', label: 'claude code' },
    { key: 'codex', label: 'codex' },
    { key: 'openclaw', label: 'openclaw' },
    { key: 'gemini', label: 'gemini' },
    { key: 'opencode', label: 'opencode' },
];

export function getAvailableNewSessionAgents(cliAvailability: MachineMetadata['cliAvailability'] | null | undefined) {
    if (!cliAvailability) {
        return ALL_AGENTS;
    }

    return ALL_AGENTS.filter((agent) => cliAvailability[agent.key] === true);
}
