import type { Machine, Session } from './storageTypes';

export type SessionListViewItem =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: Session[] }
    | { type: 'project-group'; displayPath: string; machine: Machine }
    | { type: 'session'; session: Session; variant?: 'default' | 'no-path' };

export interface BuildSessionListViewDataOptions {
    groupInactiveSessionsByProject: boolean;
}

function isSessionActive(session: { active: boolean }): boolean {
    return session.active;
}

function formatPathRelativeToHome(path: string, homeDir?: string | null): string {
    if (!homeDir) return path;

    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    const isInHome = path === normalizedHome || path.startsWith(`${normalizedHome}/`);
    if (!isInHome) {
        return path;
    }

    const relativePath = path.slice(normalizedHome.length);
    return relativePath ? `~${relativePath}` : '~';
}

function makeUnknownMachine(id: string): Machine {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

export function buildSessionListViewData(
    sessions: Record<string, Session>,
    machines: Record<string, Machine>,
    options: BuildSessionListViewDataOptions
): SessionListViewItem[] {
    const activeSessions: Session[] = [];
    const inactiveSessions: Session[] = [];

    Object.values(sessions).forEach((session) => {
        if (isSessionActive(session)) {
            activeSessions.push(session);
        } else {
            inactiveSessions.push(session);
        }
    });

    activeSessions.sort((a, b) => b.updatedAt - a.updatedAt);
    inactiveSessions.sort((a, b) => b.updatedAt - a.updatedAt);

    const listData: SessionListViewItem[] = [];

    if (activeSessions.length > 0) {
        listData.push({ type: 'active-sessions', sessions: activeSessions });
    }

    if (options.groupInactiveSessionsByProject && inactiveSessions.length > 0) {
        type ProjectGroup = {
            key: string;
            displayPath: string;
            machine: Machine;
            latestUpdatedAt: number;
            sessions: Session[];
        };

        const groups = new Map<string, ProjectGroup>();

        for (const session of inactiveSessions) {
            const machineId = session.metadata?.machineId || 'unknown';
            const path = session.metadata?.path || '';
            const key = `${machineId}:${path}`;

            const existing = groups.get(key);
            if (!existing) {
                groups.set(key, {
                    key,
                    displayPath: path ? formatPathRelativeToHome(path, session.metadata?.homeDir) : '',
                    machine: machines[machineId] ?? makeUnknownMachine(machineId),
                    latestUpdatedAt: session.updatedAt,
                    sessions: [session],
                });
            } else {
                existing.sessions.push(session);
                existing.latestUpdatedAt = Math.max(existing.latestUpdatedAt, session.updatedAt);
            }
        }

        const sortedGroups = Array.from(groups.values()).sort((a, b) => {
            if (b.latestUpdatedAt !== a.latestUpdatedAt) return b.latestUpdatedAt - a.latestUpdatedAt;
            if (a.displayPath !== b.displayPath) return a.displayPath.localeCompare(b.displayPath);
            return a.key.localeCompare(b.key);
        });

        for (const group of sortedGroups) {
            group.sessions.sort((a, b) => b.updatedAt - a.updatedAt);

            const hasGroupHeader = Boolean(group.displayPath);
            if (hasGroupHeader) {
                listData.push({ type: 'project-group', displayPath: group.displayPath, machine: group.machine });
            }

            const variant: 'default' | 'no-path' = hasGroupHeader ? 'no-path' : 'default';
            group.sessions.forEach((session) => {
                listData.push({ type: 'session', session, variant });
            });
        }

        return listData;
    }

    // Group inactive sessions by date
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    let currentDateGroup: Session[] = [];
    let currentDateString: string | null = null;

    for (const session of inactiveSessions) {
        const sessionDate = new Date(session.updatedAt);
        const dateString = sessionDate.toDateString();

        if (currentDateString !== dateString) {
            if (currentDateGroup.length > 0 && currentDateString) {
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
                currentDateGroup.forEach((sess) => {
                    listData.push({ type: 'session', session: sess });
                });
            }

            currentDateString = dateString;
            currentDateGroup = [session];
        } else {
            currentDateGroup.push(session);
        }
    }

    if (currentDateGroup.length > 0 && currentDateString) {
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
        currentDateGroup.forEach((sess) => {
            listData.push({ type: 'session', session: sess });
        });
    }

    return listData;
}
