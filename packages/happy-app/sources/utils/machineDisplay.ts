/**
 * Pure utility functions for machine/hostname display logic.
 * No React or React Native dependencies - testable in node environment.
 */

export type MinimalSession = {
    metadata: {
        host: string;
        machineId?: string;
    } | null;
};

export type MinimalMachine = {
    metadata: {
        host: string;
        displayName?: string;
    } | null;
};

/**
 * Gets the display name for a machine/host.
 * Prioritizes: Machine.displayName > short hostname > session.metadata.host
 * @param session - The session containing metadata
 * @param machine - Optional machine object
 * @returns Display name for the machine, or undefined if not available
 */
export function getMachineDisplayName(
    session: MinimalSession,
    machine?: MinimalMachine | null
): string | undefined {
    // Priority 1: Use machine's custom display name if available
    if (machine?.metadata?.displayName) {
        return machine.metadata.displayName;
    }

    // Priority 2: Use machine's short hostname
    if (machine?.metadata?.host) {
        return machine.metadata.host.split('.')[0];
    }

    // Priority 3: Fall back to session metadata host (short format)
    if (session.metadata?.host) {
        return session.metadata.host.split('.')[0];
    }

    return undefined;
}
