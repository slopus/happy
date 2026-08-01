import type { MachineMetadata } from '@/sync/storageTypes';

export type AvailableAgent = {
    key: string;
    label: string;
    name: string;
    description?: string;
};

export const BUILT_IN_AGENTS: AvailableAgent[] = [
    { key: 'claude', label: 'claude code', name: 'Claude Code' },
    { key: 'codex', label: 'codex', name: 'Codex' },
    { key: 'openclaw', label: 'openclaw', name: 'OpenClaw' },
    { key: 'agy', label: 'agy', name: 'Agy' },
];

export function getAvailableAgents(metadata: MachineMetadata | null | undefined): AvailableAgent[] {
    const advertisedAgents = metadata?.remoteCapabilities?.agents;
    if (advertisedAgents) {
        const seen = new Set<string>();
        return advertisedAgents.flatMap((agent) => {
            const key = agent.type.trim();
            const name = agent.name.trim();
            if (!key || !name || seen.has(key)) {
                return [];
            }
            seen.add(key);
            return [{
                key,
                label: name,
                name,
                ...(agent.description?.trim() ? { description: agent.description.trim() } : {}),
            }];
        });
    }

    const availability = metadata?.cliAvailability;
    if (!availability) {
        return BUILT_IN_AGENTS;
    }
    return BUILT_IN_AGENTS.filter((agent) => (
        availability[agent.key as keyof typeof availability] === true
    ));
}
