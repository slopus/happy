import type { MachineMetadata } from '@/sync/storageTypes';

/** A missing explicit owner must never silently open a different machine's archive. */
export function selectProjectMachine<T extends { id: string; active: boolean }>(
    machines: T[], routeId?: string, draftId?: string | null, previewId?: string,
): T | undefined {
    const explicitId = previewId || routeId;
    if (explicitId) return machines.find(machine => machine.id === explicitId);
    const draft = machines.find(machine => machine.id === draftId);
    return (draft?.active ? draft : undefined) ?? machines.find(machine => machine.active) ?? draft ?? machines[0];
}

export function supportsProjectCanvas(machine?: {
    active: boolean;
    metadata: Pick<MachineMetadata, 'projectCanvas'> | null;
    daemonState: { status?: string; startedAt?: number } | null;
}): boolean {
    const canvas = machine?.metadata?.projectCanvas;
    return machine?.active === true && machine.daemonState?.status === 'running'
        && canvas?.version === 1 && canvas.daemonStartedAt === machine.daemonState.startedAt;
}

/** Only a completed read can establish that a catalog is empty. */
export function projectCatalogState(state: {
    connected: boolean; online: boolean; machinesStatus?: 'loading' | 'ready' | 'error'; loading: boolean; loaded: boolean; error: string | null;
}): 'connecting' | 'offline' | 'loading' | 'error' | 'ready' {
    if (!state.connected) return 'connecting';
    if (!state.online && state.machinesStatus === 'loading') return 'connecting';
    if (!state.online && state.machinesStatus === 'error') return 'error';
    if (!state.online) return 'offline';
    if (state.error) return 'error';
    if (state.loading || !state.loaded) return 'loading';
    return 'ready';
}
