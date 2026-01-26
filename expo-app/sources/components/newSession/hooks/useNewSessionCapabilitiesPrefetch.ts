import * as React from 'react';
import { InteractionManager } from 'react-native';

export function useNewSessionCapabilitiesPrefetch(params: Readonly<{
    enabled: boolean;
    machines: ReadonlyArray<{ id: string }>;
    favoriteMachineItems: ReadonlyArray<{ id: string }>;
    recentMachines: ReadonlyArray<{ id: string }>;
    selectedMachineId: string | null;
    isMachineOnline: (machine: any) => boolean;
    staleMs: number;
    request: any;
    prefetchMachineCapabilitiesIfStale: (args: { machineId: string; staleMs: number; request: any }) => Promise<any> | void;
}>): void {
    // One-time prefetch of machine capabilities for the wizard machine list.
    // This keeps machine glyphs responsive (cache-only in the list) without
    // triggering per-row auto-detect work during taps.
    const didPrefetchWizardMachineGlyphsRef = React.useRef(false);
    React.useEffect(() => {
        if (!params.enabled) return;
        if (didPrefetchWizardMachineGlyphsRef.current) return;
        didPrefetchWizardMachineGlyphsRef.current = true;

        InteractionManager.runAfterInteractions(() => {
            try {
                const candidates: string[] = [];
                for (const m of params.favoriteMachineItems) candidates.push(m.id);
                for (const m of params.recentMachines) candidates.push(m.id);
                for (const m of params.machines.slice(0, 8)) candidates.push(m.id);

                const seen = new Set<string>();
                const unique = candidates.filter((id) => {
                    if (seen.has(id)) return false;
                    seen.add(id);
                    return true;
                });

                // Limit to avoid a thundering herd on iOS.
                const toPrefetch = unique.slice(0, 12);
                for (const machineId of toPrefetch) {
                    const machine = params.machines.find((m) => m.id === machineId);
                    if (!machine) continue;
                    if (!params.isMachineOnline(machine)) continue;
                    void params.prefetchMachineCapabilitiesIfStale({
                        machineId,
                        staleMs: params.staleMs,
                        request: params.request,
                    });
                }
            } catch {
                // best-effort prefetch only
            }
        });
    }, [params.favoriteMachineItems, params.machines, params.recentMachines, params.enabled]);

    // Cache-first + background refresh: for the actively selected machine, prefetch capabilities
    // if missing or stale. This updates the banners/agent availability on screen open, but avoids
    // any fetches on tap handlers.
    React.useEffect(() => {
        if (!params.selectedMachineId) return;
        const machine = params.machines.find((m) => m.id === params.selectedMachineId);
        if (!machine) return;
        if (!params.isMachineOnline(machine)) return;

        InteractionManager.runAfterInteractions(() => {
            void params.prefetchMachineCapabilitiesIfStale({
                machineId: params.selectedMachineId!,
                staleMs: params.staleMs,
                request: params.request,
            });
        });
    }, [params.machines, params.selectedMachineId]);
}

