import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';
import { filterProjectGroupSessions } from '@/sync/projectGroups';

/**
 * Applies the archive-visibility control to the session list.
 *
 * The rule is `session.archived`, never `!session.active`: a Rig session that
 * merely lost its connection is still live work and stays on screen, while a
 * session the agent actually retired hides. Both list shapes — the project
 * cards and the flat, date-grouped rows — run that one rule, so the single
 * toggle in the header and sidebar means the same thing wherever the list
 * happens to be rendered.
 *
 * The setting behind it is still stored as `hideInactiveSessions`: it is a
 * server-synced settings field (see sync/settings.ts) with no per-field rename
 * migration, so the key stays put and only the local naming reflects what it
 * actually does.
 */
export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideArchivedSessions = useSetting('hideInactiveSessions');

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        const visibleProjects = new Map<number, SessionListViewItem>();
        const result: SessionListViewItem[] = [];
        data.forEach((item, index) => {
            if (item.type !== 'project') return;
            const project = hideArchivedSessions
                ? filterProjectGroupSessions(item.project, (session) => !session.archived)
                : item.project;
            if (project) {
                visibleProjects.set(index, { ...item, project });
            }
        });

        data.forEach((item, index) => {
            if (item.type === 'section') {
                result.push(item);
                return;
            }
            if (item.type === 'project') {
                const project = visibleProjects.get(index);
                if (project) result.push(project);
                return;
            }
            if (item.type === 'active-sessions') result.push(item);
            if (item.type === 'session' && (!hideArchivedSessions || !item.session.archived)) result.push(item);
        });

        // A section heading is dropped once nothing under it survives the
        // filter, so hiding the archive never leaves a heading with no rows.
        return result.filter((item, index) => {
            if (item.type !== 'section') return true;
            const next = result[index + 1];
            return next != null && next.type === 'session';
        });
    }, [data, hideArchivedSessions]);
}

/**
 * Whether anything is currently hidden-able, i.e. whether the archive toggle
 * has any work to do. Keyed off the same `archived` flag the filter above uses
 * so the control never appears without changing what is on screen.
 */
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
