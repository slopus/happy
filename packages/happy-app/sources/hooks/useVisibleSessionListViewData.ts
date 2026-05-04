import * as React from 'react';
import { SessionListViewItem, SessionRowData, useSessionListViewData, useSetting } from '@/sync/storage';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Date-grouped header + session items for the archive section, keyed by the
// chosen sort field. When the user picks "last seen", the date buckets reflect
// activeAt instead of createdAt so the headers match the visible ordering.
function buildArchiveSection(
    sessions: SessionRowData[],
    dateKey: 'createdAt' | 'activeAt',
): SessionListViewItem[] {
    if (sessions.length === 0) {
        return [];
    }

    const sorted = [...sessions].sort((a, b) => (b[dateKey] ?? 0) - (a[dateKey] ?? 0));

    const items: SessionListViewItem[] = [];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - MS_PER_DAY);

    let currentDateString: string | null = null;

    for (const session of sorted) {
        const ts = session[dateKey] ?? 0;
        const d = new Date(ts);
        const dateString = d.toDateString();

        if (currentDateString !== dateString) {
            const dateOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            let title: string;
            if (dateOnly.getTime() === today.getTime()) {
                title = 'Today';
            } else if (dateOnly.getTime() === yesterday.getTime()) {
                title = 'Yesterday';
            } else {
                const diffDays = Math.floor((today.getTime() - dateOnly.getTime()) / MS_PER_DAY);
                title = `${diffDays} days ago`;
            }
            items.push({ type: 'header', title });
            currentDateString = dateString;
        }

        items.push({ type: 'session', session });
    }

    return items;
}

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const archivedSortBy = useSetting('archivedSessionsSortBy');

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        const result: SessionListViewItem[] = [];
        const inactiveSessions: SessionRowData[] = [];

        // First pass: keep the active-sessions block, collect inactive rows.
        for (const item of data) {
            if (item.type === 'active-sessions') {
                result.push(item);
            } else if (item.type === 'session' && !item.session.active) {
                inactiveSessions.push(item.session);
            }
        }

        if (inactiveSessions.length > 0) {
            result.push({ type: 'archive-toggle', hidden: hideInactiveSessions });
        }

        if (!hideInactiveSessions && inactiveSessions.length > 0) {
            result.push({ type: 'archive-sort', current: archivedSortBy });
            const dateKey = archivedSortBy === 'lastSeenAt' ? 'activeAt' : 'createdAt';
            result.push(...buildArchiveSection(inactiveSessions, dateKey));
        }

        return result;
    }, [data, hideInactiveSessions, archivedSortBy]);
}
