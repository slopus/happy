import type { GoalProject } from '@slopus/happy-wire';
import { libraryItemAvailable, libraryItemKey, type ProjectLibraryEntry } from '@/sync/projectLibrary';
import type { ProjectLocation } from '@/components/goalBoard/projectNavigation';

export interface ProjectFavoriteShortcut {
    key: string;
    kind: 'project' | 'feature';
    title: string;
    path: string;
    location: ProjectLocation;
}

/** Reuse saved favorites and their ancestor visibility rules, including offline entries. */
export function projectFavoriteShortcuts(items: ProjectLibraryEntry[], projects: GoalProject[]): ProjectFavoriteShortcut[] {
    return items.flatMap(item => {
        if (item.kind === 'file' || !item.favorite || !libraryItemAvailable(item, items)) return [];
        const project = projects.find(project => item.kind === 'project' ? project.projectPath === item.projectPath
            : project.projectPath === item.parentProjectPath || project.direct?.featurePath === item.projectPath
                || project.features.some(feature => feature.featurePath === item.projectPath));
        const feature = item.kind === 'feature' ? [project?.direct, ...project?.features ?? []].find(feature => feature?.featurePath === item.projectPath) : undefined;
        return [{
            key: libraryItemKey(item.kind, item.projectPath), kind: item.kind,
            title: (item.kind === 'project' ? project?.title : feature?.title) || item.title || item.projectPath.split('/').filter(Boolean).pop() || item.projectPath,
            path: item.projectPath,
            location: { machine: item.machineId,
                project: project?.projectPath ?? (item.kind === 'project' ? item.projectPath : item.parentProjectPath),
                feature: item.kind === 'feature' ? item.projectPath : project && !project.features.length ? project.direct?.featurePath : undefined },
        }];
    });
}

/** Prefer the specific subproject over its parent so only one shortcut is selected. */
export function selectedProjectFavorite(shortcuts: ProjectFavoriteShortcut[], location: ProjectLocation): string | undefined {
    const sameMachine = shortcuts.filter(shortcut => shortcut.location.machine === location.machine);
    return sameMachine.find(shortcut => shortcut.kind === 'feature' && shortcut.location.feature === location.feature)?.key
        ?? sameMachine.find(shortcut => shortcut.kind === 'project' && (shortcut.location.project === location.project
            || !!location.feature && shortcut.location.feature === location.feature))?.key;
}
