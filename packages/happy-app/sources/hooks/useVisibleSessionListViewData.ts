import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting, useStarredProjects } from '@/sync/storage';
import { filterProjectGroupSessions } from '@/sync/projectGroups';

/**
 * Applies the persistent archive-visibility preference to the session list.
 *
 * The rule is `session.archived`, never `!session.active`: a Rig session that
 * merely lost its connection is still live work and stays on screen, while a
 * session the agent actually retired hides. Both list shapes — the project
 * cards and the flat, date-grouped rows — run that one rule.
 *
 * `buildSessionListViewData` already routes every archived session into the
 * flat tail, so revealing the archive appends rows below the project cards
 * rather than growing them. The project pass here stays as a backstop.
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
        const visibleProjectSources = new Set<'rig' | 'happy'>();
        data.forEach((item, index) => {
            if (item.type !== 'project') return;
            const project = hideArchivedSessions
                ? filterProjectGroupSessions(item.project, (session) => !session.archived)
                : item.project;
            if (project) {
                visibleProjects.set(index, { ...item, project });
                visibleProjectSources.add(item.source);
            }
        });

        // Order is left exactly as the list data arrived in. Starred cards rise
        // in `buildSessionProjectDisplayGroups` instead — that pass sorts the
        // project cards by name as the last step before they render, so any
        // order applied here would simply be overwritten.
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

        // Flat, date-grouped rows trail the project cards. A date header is
        // held back until a row underneath it survives the filter, so hiding
        // the archive never leaves a heading with nothing under it.
        let pendingHeader: SessionListViewItem | null = null;
        for (const item of data) {
            if (item.type === 'header') {
                pendingHeader = item;
                continue;
            }
            if (item.type !== 'session') continue;
            if (hideArchivedSessions && item.session.archived) continue;
            if (pendingHeader) {
                result.push(pendingHeader);
                pendingHeader = null;
            }
            result.push(item);
        }

        return result;
    }, [data, hideArchivedSessions]);
}

/**
 * The starred project keys the home list orders by.
 *
 * Lives beside the visibility hook so the list and its keyboard shortcuts read
 * one set; the ordering itself happens where the cards are finally sorted, in
 * `buildSessionProjectDisplayGroups`.
 */
export function useSessionListStarredProjects(): ReadonlySet<string> {
    return useStarredProjects();
}

/**
 * Whether the archive-visibility control can change anything. Keyed off the
 * same `archived` flag the filter above uses so the control never appears
 * without changing what is on screen.
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
