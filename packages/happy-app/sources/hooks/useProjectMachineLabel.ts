import * as React from 'react';
import { useAllMachines, type SessionListViewItem } from '@/sync/storage';

/**
 * Resolves the machine label shown next to a project name.
 *
 * Most people run everything on one computer, where repeating its hostname
 * under every project is pure noise. The label therefore only resolves once the
 * visible projects actually span more than one machine; otherwise it returns
 * null and the header stays a single word.
 */
export function useProjectMachineLabel(items: SessionListViewItem[] | null) {
    // Offline machines included on purpose: a project outlives the daemon that
    // served it, and dropping the machine from the lookup left its raw id on
    // screen — the one thing the label exists to avoid showing.
    const machines = useAllMachines({ includeOffline: true });

    return React.useMemo(() => {
        const machineIds = new Set<string>();
        items?.forEach((item) => {
            if (item.type === 'project') machineIds.add(item.project.machineId ?? '');
        });
        if (machineIds.size <= 1) {
            return () => null;
        }

        const names = new Map(machines.map((machine) => [
            machine.id,
            machine.metadata?.displayName || machine.metadata?.host || machine.id,
        ]));
        // An unknown machine yields no label at all: a uuid tells the user less
        // than the empty space it would occupy.
        return (machineId: string | null) => (machineId ? names.get(machineId) ?? null : null);
    }, [items, machines]);
}
