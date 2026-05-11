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

        // First pass: add active sessions group and check if inactive sessions exist
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
                if (item.type === 'active-sessions') {
                    continue; // already added
                }

                if (item.type === 'project-group') {
                    pendingProjectGroup = item;
                    continue;
                }

                if (item.type === 'session') {
                    // Starred sessions render as standalone rows even when active
                    // (see buildSessionListViewData → Starred section).
                    if (!item.session.active || item.session.starred) {
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
