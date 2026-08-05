import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';
import { filterProjectGroupSessions } from '@/sync/projectGroups';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        const visibleProjects = new Map<number, SessionListViewItem>();
        const visibleProjectSources = new Set<'rig' | 'happy'>();
        data.forEach((item, index) => {
            if (item.type !== 'project') return;
            const project = hideInactiveSessions
                ? filterProjectGroupSessions(item.project, (session) => !session.archived)
                : item.project;
            if (project) {
                visibleProjects.set(index, { ...item, project });
                visibleProjectSources.add(item.source);
            }
        });

        const result: SessionListViewItem[] = [];
        data.forEach((item, index) => {
            if (item.type === 'projects-header') {
                if (visibleProjectSources.has(item.source)) result.push(item);
                return;
            }
            if (item.type === 'project') {
                const project = visibleProjects.get(index);
                if (project) result.push(project);
                return;
            }
            if (item.type === 'active-sessions') result.push(item);
        });

        if (hideInactiveSessions) return result;

        for (const item of data) {
            if (item.type === 'header' || (item.type === 'session' && !item.session.active)) {
                result.push(item);
            }
        }

        return result;
    }, [data, hideInactiveSessions]);
}

export function useHasArchivedSessions(): boolean {
    const data = useSessionListViewData();
    return React.useMemo(() => {
        if (!data) return false;
        return data.some((item) => {
            if (item.type === 'project') {
                return item.project.workspaces.some((workspace) =>
                    workspace.sessions.some((session) => session.archived),
                );
            }
            return item.type === 'session' && item.session.archived;
        });
    }, [data]);
}
