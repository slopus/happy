/**
 * Picks the agent the dock should actually run with, given the machine the user
 * chose.
 *
 * Rig only runs where a Rig daemon is connected, so agent and machine have to
 * agree — and the agent is what gives way. The dock used to resolve it the other
 * way round, snapping the machine back to the Rig one, which made a plain
 * machine impossible to select: every pick bounced straight back.
 *
 * `machineSelected` is separate from `rigConnectedHere` on purpose. Before the
 * machine list loads there is nothing to disagree with, and switching away from
 * a saved Rig choice at that moment would persist a decision the user never made.
 */
export function resolveDockAgentType<T extends string>(options: {
    agentType: T;
    rigAgentType: T;
    machineSelected: boolean;
    rigConnectedHere: boolean;
    fallbackAgentType: T | undefined;
}): T {
    const { agentType, rigAgentType, machineSelected, rigConnectedHere, fallbackAgentType } = options;
    if (agentType !== rigAgentType) return agentType;
    if (!machineSelected || rigConnectedHere) return agentType;
    return fallbackAgentType ?? agentType;
}

export function resolveCustomProjectPathSelection(
    path: string | null | undefined,
    isMounted: boolean,
) {
    if (!isMounted) {
        return null;
    }
    const trimmedPath = path?.trim();
    return trimmedPath || null;
}
