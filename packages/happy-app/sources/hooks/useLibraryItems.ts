import * as React from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getProjectLibraryRevision, libraryItemKey, projectLibraryOwner, readLibraryItems, subscribeProjectLibrary, updateLibraryItem, type ProjectLibraryEntry } from '@/sync/projectLibrary';

export type LibraryTarget = Pick<ProjectLibraryEntry, 'kind' | 'projectPath'> & Partial<Pick<ProjectLibraryEntry, 'title' | 'parentProjectPath' | 'scopePath' | 'rootPath' | 'taskId'>>;
export function useLibraryItems(machineId: string) {
    const revision = React.useSyncExternalStore(subscribeProjectLibrary, getProjectLibraryRevision, getProjectLibraryRevision);
    const owner = projectLibraryOwner();
    const items = React.useMemo(() => readLibraryItems(machineId), [machineId, revision, owner]);
    const byKey = React.useMemo(() => Object.fromEntries(items.map(item => [libraryItemKey(item.kind, item.projectPath), item])), [items]);
    const alive = React.useRef(true);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const stateOf = (target: LibraryTarget) => byKey[libraryItemKey(target.kind, target.projectPath)];
    const save = (target: LibraryTarget, patch: Partial<Pick<ProjectLibraryEntry, 'favorite' | 'state'>>) => {
        if (!alive.current || owner !== projectLibraryOwner()) return;
        const { kind, projectPath, title, parentProjectPath, scopePath, rootPath, taskId } = target;
        try { updateLibraryItem(machineId, kind, projectPath, { title, parentProjectPath, scopePath, rootPath, taskId, ...patch }, owner); }
        catch { Modal.alert(t('common.error'), t('projectGoals.librarySaveFailed')); }
    };
    return { items, stateOf, save,
        favorite: (target: LibraryTarget) => save(target, { favorite: !stateOf(target)?.favorite }),
        remove: async (target: LibraryTarget) => {
            if (await Modal.confirm(t('projectGoals.deleteLibraryItem'), t('projectGoals.deleteLibraryItemMessage', { title: target.title ?? target.projectPath.split('/').pop() ?? target.projectPath }), { destructive: true, confirmText: t('common.delete') })) save(target, { state: 'deleted' });
        },
    };
}
