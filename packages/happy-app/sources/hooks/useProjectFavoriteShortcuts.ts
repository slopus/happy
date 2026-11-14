import * as React from 'react';
import { getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { useAllMachines, useMachine, useSocketStatus } from '@/sync/storage';
import { getProjectLibraryRevision, libraryItemAvailable, projectLibraryOwner, readLibraryItems, subscribeProjectLibrary } from '@/sync/projectLibrary';
import { getProjectPreviewMachineId, loadGoalProjects } from '@/sync/projectGoals';
import { projectCacheKey, projectCatalogSchema } from '@/sync/projectWorkspaceCache';
import { useCachedProjectResource } from '@/components/goalBoard/useProjectData';
import { selectProjectMachine } from '@/components/goalBoard/projectMachine';
import { projectFavoriteShortcuts } from '@/utils/projectFavoriteShortcuts';
import { isMachineOnline } from '@/utils/machineUtils';
import { useNewSessionDraft } from './useNewSessionDraft';

/** Follow the project workspace's machine selection; refresh only on real connection/catalog events. */
export function useProjectFavoriteShortcuts(routeMachine?: string) {
    const machines = useAllMachines({ includeOffline: true });
    const draftMachine = useNewSessionDraft(state => state.selectedMachineId);
    const previewMachine = getProjectPreviewMachineId();
    const machineId = selectProjectMachine(machines, routeMachine, draftMachine, previewMachine)?.id
        ?? previewMachine ?? routeMachine ?? draftMachine ?? '';
    const owner = projectLibraryOwner();
    const revision = React.useSyncExternalStore(subscribeProjectLibrary, getProjectLibraryRevision, getProjectLibraryRevision);
    const items = React.useMemo(() => readLibraryItems(machineId), [machineId, owner, revision]);
    const hasFavorites = items.some(item => item.kind !== 'file' && item.favorite && libraryItemAvailable(item, items));
    const machine = useMachine(machineId);
    const socket = useSocketStatus();
    const archiveRevision = (machine?.daemonState as { goalProjectRevision?: string } | null)?.goalProjectRevision;
    const generation = getRuntimeAccountSelection()?.generation;
    const read = React.useCallback(() => loadGoalProjects(machineId, archiveRevision), [machineId, archiveRevision, generation]);
    const catalog = useCachedProjectResource(projectCacheKey('catalog', machineId), projectCatalogSchema, read,
        hasFavorites && !!machine && isMachineOnline(machine) && socket.status === 'connected', archiveRevision);
    const shortcuts = React.useMemo(() => projectFavoriteShortcuts(items, catalog.value ?? []), [items, catalog.value]);
    return { machineId, owner, shortcuts };
}
