import { describe, expect, it } from 'vitest';
import type { SessionListViewItem, SessionRowData } from '@/sync/storage';
import {
    buildActiveSessionDisplayGroups,
    buildSessionProjectDisplayGroups,
    getSessionShortcutIdsInDisplayOrder,
} from './sessionDisplayOrder';

function session(
    id: string,
    machineId: string,
    path: string,
    createdAt = 0,
): SessionRowData {
    return {
        id,
        name: id,
        subtitle: '',
        avatarId: id,
        flavor: null,
        clientId: null,
        identityLine: null,
        providerKind: null,
        modelName: null,
        activitySummary: null,
        gitChangedFiles: null,
        gitCountsExact: true,
        gitDeletions: null,
        gitInsertions: null,
        state: 'waiting',
        createdAt,
        lastActivityAt: createdAt,
        hasDraft: false,
        active: true,
        archived: false,
        machineId,
        machineOffline: false,
        path,
        homeDir: null,
        completedTodosCount: 0,
        totalTodosCount: 0,
        hasUnread: false,
        projectId: null,
        projectName: null,
        workspaceId: null,
        workspaceName: null,
    };
}

const machines = [
    { id: 'machine-z', metadata: { displayName: 'Zulu' } },
    { id: 'machine-a', metadata: { displayName: 'Alpha' } },
];

describe('session display order', () => {
    it('matches the sidebar machine, project, and session ordering', () => {
        const groups = buildActiveSessionDisplayGroups([
            session('zulu', 'machine-z', '/project-b'),
            session('alpha-new', 'machine-a', '/project-z', 20),
            session('alpha-old', 'machine-a', '/project-z', 10),
            session('alpha-first-project', 'machine-a', '/project-a'),
        ], machines, 'Unknown');

        expect(groups.map((group) => group.machineName)).toEqual(['Alpha', 'Zulu']);
        expect(Array.from(groups[0].projects.values())
            .sort((a, b) => a.displayPath.localeCompare(b.displayPath))
            .flatMap((project) => project.sessions.map((item) => item.id)))
            .toEqual(['alpha-first-project', 'alpha-new', 'alpha-old']);
    });

    it('numbers the first nine session rows from top to bottom', () => {
        const activeSessions = [
            session('zulu', 'machine-z', '/project'),
            session('alpha', 'machine-a', '/project'),
        ];
        const inactiveSessions = Array.from({ length: 9 }, (_, index) => ({
            type: 'session' as const,
            session: session(`inactive-${index}`, 'machine-z', '/project'),
        }));
        const data: SessionListViewItem[] = [
            { type: 'active-sessions', sessions: activeSessions },
            ...inactiveSessions,
        ];

        expect(getSessionShortcutIdsInDisplayOrder(data, machines, 'Unknown')).toEqual([
            'alpha',
            'zulu',
            'inactive-0',
            'inactive-1',
            'inactive-2',
            'inactive-3',
            'inactive-4',
            'inactive-5',
            'inactive-6',
        ]);
    });

    it('numbers sessions nested in the shared project-card layout', () => {
        const data: SessionListViewItem[] = [
            { type: 'projects-header', source: 'rig' },
            {
                type: 'project',
                source: 'rig',
                project: {
                    id: 'rig-project',
                    name: 'rig',
                    machineId: 'machine-a',
                    path: null,
                    activeCount: 1,
                    sessionCount: 1,
                    workspaces: [{
                        id: '',
                        name: null,
                        sessions: [session('rig-session', 'machine-a', '/rig')],
                    }],
                },
            },
            { type: 'projects-header', source: 'happy' },
            {
                type: 'project',
                source: 'happy',
                project: {
                    id: 'happy-project',
                    name: 'happy',
                    machineId: 'machine-a',
                    path: null,
                    activeCount: 1,
                    sessionCount: 1,
                    workspaces: [{
                        id: '',
                        name: null,
                        sessions: [session('happy-session', 'machine-a', '/happy')],
                    }],
                },
            },
        ];

        expect(getSessionShortcutIdsInDisplayOrder(data, machines, 'Unknown')).toEqual([
            'happy-session',
            'rig-session',
        ]);
    });

    it('groups project cards by machine and sorts projects within each machine', () => {
        const data: SessionListViewItem[] = [
            {
                type: 'project',
                source: 'happy',
                project: {
                    id: 'z-project',
                    name: 'Zulu project',
                    machineId: 'machine-a',
                    activeCount: 1,
                    sessionCount: 1,
                    workspaces: [{ id: '', name: null, sessions: [session('z', 'machine-a', '/z')] }],
                },
            },
            {
                type: 'project',
                source: 'happy',
                project: {
                    id: 'a-project',
                    name: 'Alpha project',
                    machineId: 'machine-a',
                    activeCount: 1,
                    sessionCount: 1,
                    workspaces: [{ id: '', name: null, sessions: [session('a', 'machine-a', '/a')] }],
                },
            },
            {
                type: 'project',
                source: 'happy',
                project: {
                    id: 'other-machine',
                    name: 'Other project',
                    machineId: 'machine-z',
                    activeCount: 1,
                    sessionCount: 1,
                    workspaces: [{ id: '', name: null, sessions: [session('other', 'machine-z', '/other')] }],
                },
            },
            {
                type: 'project',
                source: 'happy',
                project: {
                    id: 'unknown-machine',
                    name: 'Unknown project',
                    machineId: null,
                    activeCount: 1,
                    sessionCount: 1,
                    workspaces: [{ id: '', name: null, sessions: [session('unknown', '', '/unknown')] }],
                },
            },
        ];

        const groups = buildSessionProjectDisplayGroups(data, machines, 'Unknown');

        expect(groups.map(group => group.machineName)).toEqual(['Alpha', 'Zulu', '<Unknown>']);
        expect(groups[0].projects.map(item => item.project.name)).toEqual([
            'Alpha project',
            'Zulu project',
        ]);
    });
    describe('starred projects', () => {
        // Starring writes `${machineId}:${path}`, and a worktree is starred
        // under the repo it belongs to.
        function projectItem(
            id: string,
            name: string,
            path: string | null,
            machineId: string | null = 'machine-a',
        ): SessionListViewItem {
            return {
                type: 'project',
                source: 'happy',
                project: {
                    id,
                    name,
                    machineId,
                    path,
                    activeCount: 0,
                    sessionCount: 1,
                    workspaces: [{
                        id: '',
                        name: null,
                        sessions: [session(`${id}-session`, machineId ?? '', path ?? '')],
                    }],
                },
            };
        }

        const alphaAndZulu: SessionListViewItem[] = [
            projectItem('alpha', 'Alpha project', '/projects/alpha'),
            projectItem('zulu', 'Zulu project', '/projects/zulu'),
        ];

        function projectIds(
            data: SessionListViewItem[],
            starred?: ReadonlySet<string>,
        ): string[] {
            const groups = buildSessionProjectDisplayGroups(data, machines, 'Unknown', starred);
            return groups.flatMap(group => group.projects.map(item => item.project.id));
        }

        it('lifts a starred project above the alphabetical order of its machine', () => {
            expect(projectIds(alphaAndZulu, new Set(['machine-a:/projects/zulu'])))
                .toEqual(['zulu', 'alpha']);
        });

        it('keeps the alphabetical order among projects sharing a starred state', () => {
            expect(projectIds(alphaAndZulu, new Set([
                'machine-a:/projects/zulu',
                'machine-a:/projects/alpha',
            ]))).toEqual(['alpha', 'zulu']);
        });

        it('leaves the order alone when nothing is starred', () => {
            expect(projectIds(alphaAndZulu, new Set())).toEqual(['alpha', 'zulu']);
            expect(projectIds(alphaAndZulu)).toEqual(['alpha', 'zulu']);
        });

        it('rides a worktree card up on the star of the repo it belongs to', () => {
            const data = [
                projectItem('alpha', 'Alpha project', '/projects/alpha'),
                projectItem('worktree', 'feature', '/projects/repo/.dev/worktree/feature'),
            ];

            expect(projectIds(data)).toEqual(['alpha', 'worktree']);
            expect(projectIds(data, new Set(['machine-a:/projects/repo'])))
                .toEqual(['worktree', 'alpha']);
        });

        it('cannot star a card that carries no path (Rig projects)', () => {
            const data = [
                projectItem('rig-alpha', 'Alpha project', null),
                projectItem('rig-zulu', 'Zulu project', null),
            ];

            expect(projectIds(data, new Set(['machine-a:/projects/anything'])))
                .toEqual(['rig-alpha', 'rig-zulu']);
        });

        it('keeps a star inside its own machine group', () => {
            const data = [
                projectItem('alpha', 'Alpha project', '/projects/alpha'),
                projectItem('zulu-machine', 'Zulu machine project', '/projects/z', 'machine-z'),
            ];

            // machine-a leads machine-z by machine name, so starring a project
            // on machine-z lifts it within its own group, not above Alpha's.
            expect(projectIds(data, new Set(['machine-z:/projects/z'])))
                .toEqual(['alpha', 'zulu-machine']);
        });

        it('numbers the session shortcuts in the starred order too', () => {
            expect(getSessionShortcutIdsInDisplayOrder(
                alphaAndZulu,
                machines,
                'Unknown',
                new Set(['machine-a:/projects/zulu']),
            )).toEqual(['zulu-session', 'alpha-session']);
        });
    });
});
