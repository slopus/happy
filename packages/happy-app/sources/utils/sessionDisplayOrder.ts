import type { SessionListViewItem, SessionRowData } from '@/sync/storage';

export interface SessionDisplayMachine {
    id: string;
    metadata?: {
        displayName?: string | null;
        host?: string | null;
    } | null;
}

export interface ActiveSessionDisplayProject {
    displayPath: string;
    sessions: SessionRowData[];
}

export interface ActiveSessionDisplayMachineGroup {
    machineId: string;
    machineName: string;
    projects: Map<string, ActiveSessionDisplayProject>;
}

export function formatSessionDisplayPath(path: string, homeDir?: string): string {
    if (!homeDir) {
        return path;
    }
    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    if (!path.startsWith(normalizedHome)) {
        return path;
    }
    const relativePath = path.slice(normalizedHome.length);
    if (relativePath.startsWith('/')) {
        return `~${relativePath}`;
    }
    return relativePath === '' ? '~' : `~/${relativePath}`;
}

export function buildActiveSessionDisplayGroups(
    sessions: readonly SessionRowData[],
    machines: readonly SessionDisplayMachine[],
    unknownText: string,
): ActiveSessionDisplayMachineGroup[] {
    const machinesMap = new Map(machines.map((machine) => [machine.id, machine]));
    const byMachine = new Map<string, ActiveSessionDisplayMachineGroup>();

    sessions.forEach((session) => {
        const machineId = session.machineId || unknownText;
        const machine = machineId !== unknownText ? machinesMap.get(machineId) : null;
        const machineName = machine?.metadata?.displayName
            || machine?.metadata?.host
            || (machineId !== unknownText ? machineId : `<${unknownText}>`);

        let machineGroup = byMachine.get(machineId);
        if (!machineGroup) {
            machineGroup = { machineId, machineName, projects: new Map() };
            byMachine.set(machineId, machineGroup);
        }

        const projectPath = session.path || '';
        let projectGroup = machineGroup.projects.get(projectPath);
        if (!projectGroup) {
            projectGroup = {
                displayPath: formatSessionDisplayPath(projectPath, session.homeDir ?? undefined),
                sessions: [],
            };
            machineGroup.projects.set(projectPath, projectGroup);
        }
        projectGroup.sessions.push(session);
    });

    byMachine.forEach((machineGroup) => {
        machineGroup.projects.forEach((projectGroup) => {
            projectGroup.sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        });
    });

    return Array.from(byMachine.values()).sort((a, b) =>
        a.machineName.localeCompare(b.machineName)
    );
}

export function getSessionShortcutIdsInDisplayOrder(
    data: readonly SessionListViewItem[] | null,
    machines: readonly SessionDisplayMachine[],
    unknownText: string,
): string[] {
    if (!data) {
        return [];
    }

    const sessionIds: string[] = [];
    data.forEach((item) => {
        if (item.type === 'active-sessions') {
            const machineGroups = buildActiveSessionDisplayGroups(item.sessions, machines, unknownText);
            machineGroups.forEach((machineGroup) => {
                Array.from(machineGroup.projects.values())
                    .sort((a, b) => a.displayPath.localeCompare(b.displayPath))
                    .forEach((projectGroup) => {
                        projectGroup.sessions.forEach((session) => sessionIds.push(session.id));
                    });
            });
        } else if (item.type === 'session') {
            sessionIds.push(item.session.id);
        }
    });

    return sessionIds.slice(0, 9);
}
