export type CodingAgentMachines = Record<string, string[]>;
/** Installation is capability; opting in is a separate per-machine user choice. */
export function enabledCodingAgents<T extends { key: string }>(
    agents: T[], machineId: string | null, configured: CodingAgentMachines | null | undefined,
    availability: Record<string, unknown> | null | undefined,
): T[] {
    const enabled = machineId ? configured?.[machineId] ?? ['codex'] : ['codex'];
    return agents.filter(agent => enabled.includes(agent.key) && (!availability || availability[agent.key] === true));
}
