import type { SessionRowData } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { sortSessionsForList } from '@/utils/sessionPinning';

export interface SessionNavigationProjectGroup {
    displayPath: string;
    key: string;
    path: string;
    sessions: SessionRowData[];
}

export interface SessionNavigationMachineGroup {
    machineId: string;
    machineName: string;
    projects: SessionNavigationProjectGroup[];
}

export interface SessionNavigationTimeGroup {
    dayOffset: number;
    key: string;
    sessions: SessionRowData[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function getLocalDayIndex(timestamp: number): number {
    const date = new Date(timestamp);
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function getSessionRecency(session: SessionRowData): number {
    return session.activityAt ?? (Math.max(session.updatedAt ?? 0, session.activeAt ?? 0) || session.createdAt || 0);
}

export function buildSessionNavigationTimeGroups(
    sessions: SessionRowData[],
    now: number = Date.now(),
): SessionNavigationTimeGroup[] {
    const currentDay = getLocalDayIndex(now);
    const grouped = new Map<number, SessionRowData[]>();

    for (const session of [...sessions].sort((a, b) => getSessionRecency(b) - getSessionRecency(a))) {
        const day = getLocalDayIndex(getSessionRecency(session));
        const group = grouped.get(day) ?? [];
        group.push(session);
        grouped.set(day, group);
    }

    return Array.from(grouped.entries())
        .sort(([a], [b]) => b - a)
        .map(([day, groupedSessions]) => ({
            dayOffset: Math.max(0, currentDay - day),
            key: String(day),
            sessions: groupedSessions,
        }));
}

export function getSessionNavigationProjectKey(machineId: string, projectPath: string): string {
    return `${encodeURIComponent(machineId)}--${encodeURIComponent(projectPath)}`;
}

export function buildSessionNavigationGroups({
    machines,
    pinnedOrder,
    sessions,
    unknownLabel,
}: {
    machines: Machine[];
    pinnedOrder: string[];
    sessions: SessionRowData[];
    unknownLabel: string;
}): SessionNavigationMachineGroup[] {
    const machinesById = new Map(machines.map((machine) => [machine.id, machine]));
    const machineGroups = new Map<string, {
        machineId: string;
        machineName: string;
        projects: Map<string, SessionNavigationProjectGroup>;
    }>();

    for (const session of sessions) {
        const machineId = session.machineId || unknownLabel;
        const machine = machineId === unknownLabel ? null : machinesById.get(machineId);
        const machineName = machine?.metadata?.displayName
            || machine?.metadata?.host
            || (machineId === unknownLabel ? `<${unknownLabel}>` : machineId);
        let machineGroup = machineGroups.get(machineId);

        if (!machineGroup) {
            machineGroup = { machineId, machineName, projects: new Map() };
            machineGroups.set(machineId, machineGroup);
        }

        const projectPath = session.path || '';
        let projectGroup = machineGroup.projects.get(projectPath);
        if (!projectGroup) {
            projectGroup = {
                displayPath: formatPathRelativeToHome(projectPath, session.homeDir ?? undefined),
                key: getSessionNavigationProjectKey(machineId, projectPath),
                path: projectPath,
                sessions: [],
            };
            machineGroup.projects.set(projectPath, projectGroup);
        }
        projectGroup.sessions.push(session);
    }

    return Array.from(machineGroups.values())
        .map((machineGroup) => ({
            machineId: machineGroup.machineId,
            machineName: machineGroup.machineName,
            projects: Array.from(machineGroup.projects.values())
                .map((project) => ({
                    ...project,
                    sessions: sortSessionsForList(project.sessions, pinnedOrder),
                }))
                .sort((a, b) => a.displayPath.localeCompare(b.displayPath)),
        }))
        .sort((a, b) => a.machineName.localeCompare(b.machineName));
}
