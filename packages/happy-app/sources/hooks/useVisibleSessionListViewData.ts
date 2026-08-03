import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        const result: SessionListViewItem[] = [];
        let hasInactive = false;

        // First pass: projects lead, then the active sessions group. Projects
        // carry their own archived sessions, so the toggle below never hides
        // them and they are not counted as inactive here.
        for (const item of data) {
            if (item.type === 'projects-header' || item.type === 'project') {
                result.push(item);
            }
        }
        for (const item of data) {
            if (item.type === 'active-sessions') {
                result.push(item);
            } else if (item.type === 'session' && !item.session.active) {
                hasInactive = true;
            }
        }

        // Insert archive toggle if there are inactive sessions
        if (hasInactive) {
            result.push({ type: 'archive-toggle', hidden: hideInactiveSessions });
        }

        // If not hiding, add all remaining items (headers, project groups, inactive sessions)
        if (!hideInactiveSessions) {
            let pendingProjectGroup: SessionListViewItem | null = null;

            for (const item of data) {
                if (item.type === 'active-sessions' || item.type === 'projects-header' || item.type === 'project') {
                    continue; // already added
                }

                if (item.type === 'project-group') {
                    pendingProjectGroup = item;
                    continue;
                }

                if (item.type === 'session') {
                    if (!item.session.active) {
                        if (pendingProjectGroup) {
                            result.push(pendingProjectGroup);
                            pendingProjectGroup = null;
                        }
                        result.push(item);
                    }
                    continue;
                }

                pendingProjectGroup = null;

                if (item.type === 'header') {
                    result.push(item);
                }
            }
        }

        return result;
    }, [data, hideInactiveSessions]);
}
