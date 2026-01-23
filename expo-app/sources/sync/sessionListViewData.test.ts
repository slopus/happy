import { describe, expect, it } from 'vitest';
import type { Machine, Session } from './storageTypes';
import { buildSessionListViewData } from './sessionListViewData';

function makeSession(partial: Partial<Session> & Pick<Session, 'id'>): Session {
    const active = partial.active ?? false;
    const createdAt = partial.createdAt ?? 0;
    const activeAt = partial.activeAt ?? createdAt;
    const updatedAt = partial.updatedAt ?? createdAt;
    return {
        id: partial.id,
        seq: partial.seq ?? 0,
        createdAt,
        updatedAt,
        active,
        activeAt,
        metadata: partial.metadata ?? null,
        metadataVersion: partial.metadataVersion ?? 0,
        agentState: partial.agentState ?? null,
        agentStateVersion: partial.agentStateVersion ?? 0,
        thinking: partial.thinking ?? false,
        thinkingAt: partial.thinkingAt ?? 0,
        presence: active ? 'online' : activeAt,
        todos: partial.todos,
        draft: partial.draft,
        permissionMode: partial.permissionMode ?? null,
        permissionModeUpdatedAt: partial.permissionModeUpdatedAt ?? null,
        modelMode: partial.modelMode ?? null,
        latestUsage: partial.latestUsage ?? null,
    };
}

function makeMachine(partial: Partial<Machine> & Pick<Machine, 'id'>): Machine {
    const createdAt = partial.createdAt ?? 0;
    const active = partial.active ?? false;
    const activeAt = partial.activeAt ?? createdAt;
    return {
        id: partial.id,
        seq: partial.seq ?? 0,
        createdAt,
        updatedAt: partial.updatedAt ?? createdAt,
        active,
        activeAt,
        metadata: partial.metadata ?? null,
        metadataVersion: partial.metadataVersion ?? 0,
        daemonState: partial.daemonState ?? null,
        daemonStateVersion: partial.daemonStateVersion ?? 0,
    };
}

describe('buildSessionListViewData', () => {
    it('groups inactive sessions by machine+path when enabled', () => {
        const machineA = makeMachine({ id: 'm1', metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' } });
        const machineB = makeMachine({ id: 'm2', metadata: { host: 'm2', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/u' } });

        const sessions: Record<string, Session> = {
            active: makeSession({
                id: 'active',
                active: true,
                createdAt: 1,
                updatedAt: 50,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            a1: makeSession({
                id: 'a1',
                createdAt: 2,
                updatedAt: 100,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            a2: makeSession({
                id: 'a2',
                createdAt: 3,
                updatedAt: 200,
                metadata: { machineId: 'm1', path: '/home/u/repoA', homeDir: '/home/u', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
            b1: makeSession({
                id: 'b1',
                createdAt: 4,
                updatedAt: 150,
                metadata: { machineId: 'm2', path: '/home/u/repoB', homeDir: '/home/u', host: 'm2', version: '0.0.0', flavor: 'claude' },
            }),
        };

        const machines: Record<string, Machine> = {
            [machineA.id]: machineA,
            [machineB.id]: machineB,
        };

        const data = buildSessionListViewData(sessions, machines, { groupInactiveSessionsByProject: true });

        const summary = data.map((item) => {
            switch (item.type) {
                case 'active-sessions':
                    return `active:${item.sessions.map((s) => s.id).join(',')}`;
                case 'project-group':
                    return `group:${item.machine.id}:${item.displayPath}`;
                case 'session':
                    return `session:${item.session.id}:${item.variant ?? 'default'}`;
                case 'header':
                    return `header:${item.title}`;
            }
        });

        expect(summary).toEqual([
            'active:active',
            'group:m1:~/repoA',
            'session:a2:no-path',
            'session:a1:no-path',
            'group:m2:~/repoB',
            'session:b1:no-path',
        ]);
    });

    it('does not treat /home/userfoo as inside /home/user', () => {
        const machine = makeMachine({ id: 'm1', metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '0.0.0', happyHomeDir: '/h', homeDir: '/home/user' } });

        const sessions: Record<string, Session> = {
            s1: makeSession({
                id: 's1',
                createdAt: 1,
                updatedAt: 2,
                metadata: { machineId: 'm1', path: '/home/userfoo/repo', homeDir: '/home/user', host: 'm1', version: '0.0.0', flavor: 'claude' },
            }),
        };

        const data = buildSessionListViewData(sessions, { [machine.id]: machine }, { groupInactiveSessionsByProject: true });
        const group = data.find((i) => i.type === 'project-group') as any;
        expect(group?.displayPath).toBe('/home/userfoo/repo');
    });
});
