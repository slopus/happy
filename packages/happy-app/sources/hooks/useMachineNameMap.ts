// Builds a machineId → displayName map from the synced machine list.
// Used by orchestrator pages to show human-readable device names instead of raw UUIDs.
import * as React from 'react';
import { useAllMachines } from '@/sync/storage';

export function useMachineNameMap(): ReadonlyMap<string, string> {
    const allMachines = useAllMachines();
    return React.useMemo(() => {
        const map = new Map<string, string>();
        for (const machine of allMachines) {
            const name = machine.metadata?.displayName || machine.metadata?.host;
            if (name) {
                map.set(machine.id, name);
            }
        }
        return map;
    }, [allMachines]);
}
