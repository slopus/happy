import { describe, expect, it, vi } from 'vitest';
import type { SessionRowData } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import {
    buildSessionNavigationGroups,
    buildSessionNavigationTimeGroups,
    getSessionNavigationProjectKey,
} from './sessionNavigationGroups';

vi.mock('@/utils/sessionUtils', () => ({
    formatPathRelativeToHome: (projectPath: string, homeDir?: string) => homeDir && projectPath.startsWith(homeDir)
        ? `~${projectPath.slice(homeDir.length)}`
        : projectPath,
}));

function session(overrides: Partial<SessionRowData> & Pick<SessionRowData, 'id'>): SessionRowData {
    return {
        active: false,
        archived: false,
        avatarId: 'avatar',
        completedTodosCount: 0,
        flavor: 'codex',
        hasDraft: false,
        hasUnread: false,
        homeDir: '/Users/jacky',
        machineId: 'machine-b',
        name: overrides.id,
        path: '/Users/jacky/zeta',
        state: 'idle',
        isConnected: false,
        subtitle: '',
        totalTodosCount: 0,
        ...overrides,
    };
}

function machine(id: string, displayName: string): Machine {
    return {
        active: true,
        activeAt: 1,
        createdAt: 1,
        daemonState: null,
        daemonStateVersion: 0,
        id,
        metadata: {
            displayName,
            happyCliVersion: '1.0.0',
            happyHomeDir: '/Users/jacky/.happy',
            homeDir: '/Users/jacky',
            host: displayName,
            platform: 'darwin',
        },
        metadataVersion: 1,
        seq: 1,
        updatedAt: 1,
    };
}

describe('session navigation groups', () => {
    it('sorts the time layout by latest activity and groups local calendar days', () => {
        const now = new Date(2026, 7, 6, 12).getTime();
        const groups = buildSessionNavigationTimeGroups([
            session({ id: 'yesterday', activeAt: new Date(2026, 7, 5, 18).getTime(), createdAt: 1 }),
            session({ id: 'today-created', createdAt: new Date(2026, 7, 6, 8).getTime() }),
            session({ id: 'today-active', activeAt: new Date(2026, 7, 6, 10).getTime(), createdAt: 1 }),
            session({ id: 'older', createdAt: new Date(2026, 7, 3, 20).getTime() }),
        ], now);

        expect(groups.map((group) => group.dayOffset)).toEqual([0, 1, 3]);
        expect(groups[0].sessions.map((item) => item.id)).toEqual(['today-active', 'today-created']);
        expect(groups[1].sessions.map((item) => item.id)).toEqual(['yesterday']);
        expect(groups[2].sessions.map((item) => item.id)).toEqual(['older']);
    });

    it('places a session in the day of its latest activity instead of its creation day', () => {
        const now = new Date(2026, 7, 6, 12).getTime();
        const groups = buildSessionNavigationTimeGroups([
            session({
                id: 'continued-today',
                createdAt: new Date(2026, 7, 5, 18).getTime(),
                updatedAt: new Date(2026, 7, 6, 10).getTime(),
            }),
        ], now);

        expect(groups).toMatchObject([{
            dayOffset: 0,
            sessions: [{ id: 'continued-today' }],
        }]);
    });

    it('uses a newer live activity timestamp over an older persisted update', () => {
        const now = new Date(2026, 7, 6, 12).getTime();
        const groups = buildSessionNavigationTimeGroups([
            session({
                id: 'live-today',
                createdAt: new Date(2026, 7, 5, 18).getTime(),
                updatedAt: new Date(2026, 7, 5, 20).getTime(),
                activeAt: new Date(2026, 7, 6, 10).getTime(),
            }),
        ], now);

        expect(groups[0]).toMatchObject({
            dayOffset: 0,
            sessions: [{ id: 'live-today' }],
        });
    });

    it('uses machines as grouping and projects as sorted collapsible units', () => {
        const groups = buildSessionNavigationGroups({
            machines: [machine('machine-b', 'Studio'), machine('machine-a', 'Remote')],
            pinnedOrder: ['zeta-old'],
            sessions: [
                session({ id: 'zeta-new', createdAt: 20 }),
                session({ id: 'alpha', machineId: 'machine-b', path: '/Users/jacky/alpha' }),
                session({ id: 'remote', machineId: 'machine-a', path: '/srv/remote', homeDir: '/srv' }),
                session({ id: 'zeta-old', createdAt: 10 }),
            ],
            unknownLabel: 'Unknown',
        });

        expect(groups.map((group) => group.machineName)).toEqual(['Remote', 'Studio']);
        expect(groups[1].projects.map((project) => project.displayPath)).toEqual(['~/alpha', '~/zeta']);
        expect(groups[1].projects[1].sessions.map((item) => item.id)).toEqual(['zeta-old', 'zeta-new']);
        expect(groups[1].projects[1].key).toBe(getSessionNavigationProjectKey('machine-b', '/Users/jacky/zeta'));
    });

    it('keeps missing machine and path data in an explicit fallback group', () => {
        const groups = buildSessionNavigationGroups({
            machines: [],
            pinnedOrder: [],
            sessions: [session({ id: 'unknown', machineId: null, path: null, homeDir: null })],
            unknownLabel: 'Unknown',
        });

        expect(groups).toHaveLength(1);
        expect(groups[0].machineName).toBe('<Unknown>');
        expect(groups[0].projects[0].key).toBe(getSessionNavigationProjectKey('Unknown', ''));
        expect(groups[0].projects[0].sessions[0].id).toBe('unknown');
    });

    it('keeps a 3-machine, 10-project, 50-session navigation fixture structured', () => {
        const machines = [
            machine('machine-0', 'Machine 0'),
            machine('machine-1', 'Machine 1'),
            machine('machine-2', 'Machine 2'),
        ];
        const sessions = Array.from({ length: 50 }, (_, index) => {
            const projectIndex = index % 10;
            return session({
                id: `session-${index}`,
                machineId: `machine-${projectIndex % 3}`,
                path: `/Users/jacky/project-${projectIndex}`,
            });
        });
        const groups = buildSessionNavigationGroups({
            machines,
            pinnedOrder: [],
            sessions,
            unknownLabel: 'Unknown',
        });

        expect(groups).toHaveLength(3);
        expect(groups.reduce((count, group) => count + group.projects.length, 0)).toBe(10);
        expect(groups.flatMap((group) => group.projects).flatMap((project) => project.sessions)).toHaveLength(50);
    });
});
