import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';
import { filterProjectGroupSessions } from '@/sync/projectGroups';

/**
 * The session list has two independent axes and this hook applies both.
 *
 * `archived` is a user decision: the session was filed away and belongs on the
 * archive screen, never in the main list. `active` is the agent process: a
 * session that merely finished is still ordinary work and stays in the list,
 * dimmed, unless the user opted into hiding finished sessions through the
 * `hideInactiveSessions` setting.
 *
 * Both list shapes — project cards and the flat, date-grouped rows — run the
 * same two rules, so the list means the same thing wherever it is rendered.
 */
export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    return useFilteredSessionListViewData(
        React.useCallback(
            (session: { active: boolean; archived: boolean }) =>
                !session.archived && (!hideInactiveSessions || session.active),
            [hideInactiveSessions],
        ),
    );
}

/**
 * The archive screen's mirror image of the list: only the sessions the user
 * filed away, in the same project / date grouping the main list uses.
 */
export function useArchivedSessionListViewData(): SessionListViewItem[] | null {
    return useFilteredSessionListViewData(
        React.useCallback((session: { archived: boolean }) => session.archived, []),
    );
}

/**
 * Shared plumbing behind both lists: applies a per-session predicate to the
 * project cards and the flat rows alike, then drops any project or date
 * heading left with nothing under it.
 */
function useFilteredSessionListViewData(
    predicate: (session: { active: boolean; archived: boolean }) => boolean,
): SessionListViewItem[] | null {
    const data = useSessionListViewData();

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        const visibleProjects = new Map<number, SessionListViewItem>();
        const result: SessionListViewItem[] = [];
        data.forEach((item, index) => {
            if (item.type !== 'project') return;
            const project = filterProjectGroupSessions(item.project, predicate);
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
            if (item.type === 'session' && predicate(item.session)) result.push(item);
        });

        // A section heading is dropped once nothing under it survives the
        // filter, so filtering never leaves a heading with no rows.
        return result.filter((item, index) => {
            if (item.type !== 'section') return true;
            const next = result[index + 1];
            return next != null && next.type === 'session';
        });
    }, [data, predicate]);
}
