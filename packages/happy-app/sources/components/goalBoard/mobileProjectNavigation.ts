import type { ProjectLocation } from './projectNavigation';
import type { GoalProject } from '@slopus/happy-wire';

export type MobileProjectLocation = ProjectLocation & { view?: string; file?: string };
export const mobileProjectKeys = ['machine', 'project', 'feature', 'task', 'conversation', 'author', 'view', 'file'] as const;

export function findProjectForLocation(projects: GoalProject[], location: ProjectLocation) {
    return projects.find(project => location.project ? project.projectPath === location.project : !!location.feature
        && (project.direct?.featurePath === location.feature || project.features.some(entry => entry.featurePath === location.feature)));
}

export function mergeMobileProjectLocation(current: MobileProjectLocation, patch: MobileProjectLocation): MobileProjectLocation {
    return Object.fromEntries(mobileProjectKeys.map(key => [key, key in patch ? patch[key] : current[key]]));
}

/** Only directory/Task entry and opening a reader add a screen. Task views and sessions replace it. */
export function replaceMobileProjectLocation(current: MobileProjectLocation, next: MobileProjectLocation) {
    return !!current.task && ['machine', 'project', 'feature', 'task'].every(key => current[key as keyof ProjectLocation] === next[key as keyof ProjectLocation])
        && (current.view === 'reader') === (next.view === 'reader');
}

/** Expo inserts a home anchor on cold links; it is not a visited project parent. */
export function canPopMobileProjectLocation(current: MobileProjectLocation, previousRouteName?: string) {
    return previousRouteName === 'projects' || !(current.project || current.feature || current.task || current.author);
}

/** Deep links have no in-app predecessor; return to their actual parent. */
export function mobileProjectParent(location: MobileProjectLocation, project?: Pick<GoalProject, 'projectPath' | 'features'>): MobileProjectLocation {
    const current = location.feature && !location.project && project ? { ...location, project: project.projectPath } : location;
    if (current.view === 'reader') return { ...current, file: undefined, view: 'files' };
    if (current.task || current.author) return { ...current, task: undefined, conversation: undefined, author: undefined, view: undefined, file: undefined };
    if (current.feature) return project && !project.features.length ? { machine: current.machine } : { ...current, feature: undefined };
    return { machine: current.machine };
}
