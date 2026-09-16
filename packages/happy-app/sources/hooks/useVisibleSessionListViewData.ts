import * as React from 'react';
import { SessionListViewItem, SessionRowData, useSessionListViewData, useSetting } from '@/sync/storage';
import { filterProjectGroupSessions } from '@/sync/projectGroups';

/**
 * Applies the persistent archive-visibility preference and the live search
 * query to the session list.
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
 *
 * The search query matches the row title (`session.name` — bot name or the
 * agent's summary) with the working path as fallback: sessions without a
 * summary all share the "New chat" title, and the path is what tells them
 * apart. Matching is a case-insensitive substring over data the client has
 * already decrypted: session metadata is E2EE, so the server cannot run this
 * query for us.
 */
export function useVisibleSessionListViewData(searchQuery = ''): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideArchivedSessions = useSetting('hideInactiveSessions');
    const query = searchQuery.trim().toLowerCase();

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        const matchesSearch = (session: Pick<SessionRowData, 'name' | 'path'>) => {
            if (!query) return true;
            return session.name.toLowerCase().includes(query)
                || (session.path ?? '').toLowerCase().includes(query);
        };
        const keep = (session: SessionRowData) =>
            (!hideArchivedSessions || !session.archived) && matchesSearch(session);

        const visibleProjects = new Map<number, SessionListViewItem>();
        const visibleProjectSources = new Set<'rig' | 'happy'>();
        data.forEach((item, index) => {
            if (item.type !== 'project') return;
            const project = hideArchivedSessions || query
                ? filterProjectGroupSessions(item.project, keep)
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
            if (item.type === 'active-sessions' || item.type === 'bots') {
                if (!query) {
                    result.push(item);
                    return;
                }
                const sessions = item.sessions.filter(matchesSearch);
                if (sessions.length > 0) result.push({ ...item, sessions });
                return;
            }
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
            if (!keep(item.session)) continue;
            if (pendingHeader) {
                result.push(pendingHeader);
                pendingHeader = null;
            }
            result.push(item);
        }

        return result;
    }, [data, hideArchivedSessions, query]);
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
