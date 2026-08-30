import type { SessionListViewItem, SessionRowData } from '@/sync/storage';

type SessionProjectListItem = Extract<SessionListViewItem, { type: 'project' }>;

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

export interface SessionProjectDisplayMachineGroup {
    machineId: string | null;
    machineName: string;
    projects: SessionProjectListItem[];
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

    return Array.from(byMachine.values()).sort((a, b) => (
        Number(a.machineId === unknownText) - Number(b.machineId === unknownText)
        || a.machineName.localeCompare(b.machineName)
    ));
}

/**
 * Restores the home list's original top-level hierarchy: machine first, then
 * projects, with worktrees and sessions kept inside each project.
 */
export function buildSessionProjectDisplayGroups(
    data: readonly SessionListViewItem[],
    machines: readonly SessionDisplayMachine[],
    unknownText: string,
): SessionProjectDisplayMachineGroup[] {
    const machinesMap = new Map(machines.map((machine) => [machine.id, machine]));
    const byMachine = new Map<string | null, SessionProjectDisplayMachineGroup>();

    data.forEach((item) => {
        if (item.type !== 'project') return;

        const machineId = item.project.machineId;
        const machine = machineId ? machinesMap.get(machineId) : null;
        const machineName = machine?.metadata?.displayName
            || machine?.metadata?.host
            || (machineId ?? `<${unknownText}>`);
        let group = byMachine.get(machineId);
        if (!group) {
            group = { machineId, machineName, projects: [] };
            byMachine.set(machineId, group);
        }
        group.projects.push(item);
    });

    byMachine.forEach((group) => {
        group.projects.sort((a, b) => (
            a.project.name.localeCompare(b.project.name)
            || a.project.id.localeCompare(b.project.id)
        ));
    });

    return Array.from(byMachine.values()).sort((a, b) => (
        Number(a.machineId === null) - Number(b.machineId === null)
        || a.machineName.localeCompare(b.machineName)
    ));
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
    const projectGroups = buildSessionProjectDisplayGroups(data, machines, unknownText);
    projectGroups.forEach((machineGroup) => {
        machineGroup.projects.forEach((item) => {
            item.project.workspaces.forEach((workspace) => {
                workspace.sessions.forEach((session) => sessionIds.push(session.id));
            });
        });
    });

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
