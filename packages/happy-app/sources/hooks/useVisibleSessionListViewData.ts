import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSharedSessions, useOwnSessionsSharedByMe } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';

// Returns only active sessions for the main "Active" tab
export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        const filtered: SessionListViewItem[] = [];
        let pendingProjectGroup: SessionListViewItem | null = null;
        let inSharedSection = false;
        let pendingSharedHeader: SessionListViewItem | null = null;

        for (const item of data) {
            // Keep shared section, but still filter inactive sessions within it
            if (item.type === 'header' && item.title === 'Shared with me') {
                inSharedSection = true;
                pendingSharedHeader = item;
                continue;
            }
            if (inSharedSection) {
                if (item.type === 'session' && item.session.active) {
                    if (pendingSharedHeader) {
                        filtered.push(pendingSharedHeader);
                        pendingSharedHeader = null;
                    }
                    filtered.push(item);
                }
                continue;
            }

            if (item.type === 'project-group') {
                pendingProjectGroup = item;
                continue;
            }

            if (item.type === 'session') {
                if (item.session.active) {
                    if (pendingProjectGroup) {
                        filtered.push(pendingProjectGroup);
                        pendingProjectGroup = null;
                    }
                    filtered.push(item);
                }
                continue;
            }

            pendingProjectGroup = null;

            if (item.type === 'active-sessions') {
                filtered.push(item);
            }
        }

        return filtered;
    }, [data]);
}

// Returns only inactive sessions for the "Inactive" tab, grouped by date
export function useInactiveSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();

    return React.useMemo(() => {
        if (!data) {
            return null;
        }

        // Collect all inactive sessions from the main list (excluding shared section)
        const inactiveSessions: Session[] = [];
        let inSharedSection = false;

        for (const item of data) {
            if (item.type === 'header' && item.title === 'Shared with me') {
                inSharedSection = true;
                continue;
            }
            if (inSharedSection) {
                continue;
            }
            if (item.type === 'session' && !item.session.active) {
                inactiveSessions.push(item.session);
            }
        }

        if (inactiveSessions.length === 0) {
            return [];
        }

        inactiveSessions.sort((a, b) => b.updatedAt - a.updatedAt);

        return groupSessionsByDate(inactiveSessions);
    }, [data]);
}

// Groups sessions by date with headers (Today, Yesterday, X days ago)
function groupSessionsByDate(sessions: Session[]): SessionListViewItem[] {
    const listData: SessionListViewItem[] = [];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    let currentDateGroup: Session[] = [];
    let currentDateString: string | null = null;

    const flushGroup = () => {
        if (currentDateGroup.length === 0 || !currentDateString) return;

        const groupDate = new Date(currentDateString);
        const sessionDateOnly = new Date(groupDate.getFullYear(), groupDate.getMonth(), groupDate.getDate());

        let headerTitle: string;
        if (sessionDateOnly.getTime() === today.getTime()) {
            headerTitle = 'Today';
        } else if (sessionDateOnly.getTime() === yesterday.getTime()) {
            headerTitle = 'Yesterday';
        } else {
            const diffTime = today.getTime() - sessionDateOnly.getTime();
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            headerTitle = `${diffDays} days ago`;
        }

        listData.push({ type: 'header', title: headerTitle });
        for (const sess of currentDateGroup) {
            listData.push({ type: 'session', session: sess });
        }
    };

    for (const session of sessions) {
        const sessionDate = new Date(session.updatedAt);
        const dateString = sessionDate.toDateString();

        if (currentDateString !== dateString) {
            flushGroup();
            currentDateString = dateString;
            currentDateGroup = [session];
        } else {
            currentDateGroup.push(session);
        }
    }
    flushGroup();

    return listData;
}

export function useSharedSessionListViewData(): SessionListViewItem[] | null {
    const sessions = useSharedSessions();
    const isReady = useSessionListViewData() !== null;

    return React.useMemo(() => {
        if (!isReady) {
            return null;
        }

        if (sessions.length === 0) {
            return [];
        }

        const activeSessions: Session[] = [];
        const inactiveSessions: Session[] = [];

        for (const session of sessions) {
            if (session.active) {
                activeSessions.push(session);
            } else {
                inactiveSessions.push(session);
            }
        }

        activeSessions.sort((a, b) => b.updatedAt - a.updatedAt);
        inactiveSessions.sort((a, b) => b.updatedAt - a.updatedAt);

        const listData: SessionListViewItem[] = [];

        if (activeSessions.length > 0) {
            listData.push({ type: 'active-sessions', sessions: activeSessions });
        }

        listData.push(...groupSessionsByDate(inactiveSessions));

        return listData;
    }, [sessions, isReady]);
}

// Returns list view data for sessions the current user has shared with others (isShared === true)
export function useSharedByMeSessionListViewData(): SessionListViewItem[] | null {
    const sharedByMe = useOwnSessionsSharedByMe();
    const isReady = useSessionListViewData() !== null;

    return React.useMemo(() => {
        if (!isReady) {
            return null;
        }

        if (sharedByMe.length === 0) {
            return [];
        }

        const activeSessions: Session[] = [];
        const inactiveSessions: Session[] = [];

        for (const session of sharedByMe) {
            if (session.active) {
                activeSessions.push(session);
            } else {
                inactiveSessions.push(session);
            }
        }

        activeSessions.sort((a, b) => b.updatedAt - a.updatedAt);
        inactiveSessions.sort((a, b) => b.updatedAt - a.updatedAt);

        const listData: SessionListViewItem[] = [];

        if (activeSessions.length > 0) {
            listData.push({ type: 'active-sessions', sessions: activeSessions });
        }

        listData.push(...groupSessionsByDate(inactiveSessions));

        return listData;
    }, [sharedByMe, isReady]);
}
