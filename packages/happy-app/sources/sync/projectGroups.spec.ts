import { describe, expect, it } from 'vitest';

import { buildProjectGroups } from './projectGroups';
import type { Session } from './storageTypes';
import type { SessionRowData } from './storage';

function session(options: {
    id: string;
    projectId?: string;
    projectName?: string;
    workspaceId?: string;
    workspaceName?: string;
    active?: boolean;
    machineId?: string;
}): Session {
    const active = options.active ?? true;
    return {
        id: options.id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active,
        activeAt: active ? Date.now() : 0,
        metadata: {
            path: '/repo',
            host: 'localhost',
            machineId: options.machineId ?? 'machine-1',
            client: { id: 'rig', name: 'Rig', version: 'test' },
            ...(options.projectId === undefined ? {} : {
                project: { id: options.projectId, kind: 'regular', name: options.projectName ?? 'Repo' },
            }),
            ...(options.workspaceId === undefined ? {} : {
                workspace: { id: options.workspaceId, kind: 'git_worktree', name: options.workspaceName ?? 'wt' },
            }),
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: active ? 'online' : 0,
    };
}

// Only the fields the grouping actually reads; the real row builder lives in
// storage.ts, which pulls in React Native and cannot be loaded here.
function toRow(session: Session): SessionRowData {
    return {
        id: session.id,
        clientId: session.metadata?.client?.id ?? null,
        projectId: session.metadata?.project?.id ?? null,
        projectName: session.metadata?.project?.name ?? null,
        workspaceId: session.metadata?.workspace?.id ?? null,
        workspaceName: session.metadata?.workspace?.name ?? null,
    } as SessionRowData;
}

const isActive = (session: Session) => session.active;

describe('buildProjectGroups', () => {
    it('gathers every worktree of a repo under one project', () => {
        const groups = buildProjectGroups([
            session({ id: 'a', projectId: 'p1', projectName: 'happy' }),
            session({ id: 'b', projectId: 'p1', workspaceId: 'w1', workspaceName: 'feature' }),
            session({ id: 'c', projectId: 'p1', workspaceId: 'w2', workspaceName: 'bugfix' }),
        ], toRow, isActive);

        expect(groups).toHaveLength(1);
        expect(groups[0].name).toBe('happy');
        expect(groups[0].sessionCount).toBe(3);
        expect(groups[0].workspaces.map(w => w.name)).toEqual([null, 'feature', 'bugfix']);
    });

    it('keeps separate projects apart', () => {
        const groups = buildProjectGroups([
            session({ id: 'a', projectId: 'p1', projectName: 'one' }),
            session({ id: 'b', projectId: 'p2', projectName: 'two' }),
        ], toRow, isActive);

        expect(groups.map(g => g.name)).toEqual(['one', 'two']);
    });

    it('puts the primary tree first even when a worktree session comes first', () => {
        const groups = buildProjectGroups([
            session({ id: 'a', projectId: 'p1', workspaceId: 'w1', workspaceName: 'feature' }),
            session({ id: 'b', projectId: 'p1' }),
        ], toRow, isActive);

        expect(groups[0].workspaces.map(w => w.id)).toEqual(['', 'w1']);
    });

    it('groups several sessions inside the same worktree', () => {
        const groups = buildProjectGroups([
            session({ id: 'a', projectId: 'p1', workspaceId: 'w1' }),
            session({ id: 'b', projectId: 'p1', workspaceId: 'w1' }),
        ], toRow, isActive);

        expect(groups[0].workspaces).toHaveLength(1);
        expect(groups[0].workspaces[0].sessions.map(s => s.id)).toEqual(['a', 'b']);
    });

    it('counts active sessions separately from the total', () => {
        const groups = buildProjectGroups([
            session({ id: 'a', projectId: 'p1' }),
            session({ id: 'b', projectId: 'p1', active: false }),
        ], toRow, isActive);

        expect(groups[0].sessionCount).toBe(2);
        expect(groups[0].activeCount).toBe(1);
    });

    it('carries the project identity onto each row', () => {
        const groups = buildProjectGroups([
            session({ id: 'a', projectId: 'p1', projectName: 'happy', workspaceId: 'w1', workspaceName: 'feature' }),
        ], toRow, isActive);

        expect(groups[0].workspaces[0].sessions[0]).toMatchObject({
            clientId: 'rig',
            projectId: 'p1',
            projectName: 'happy',
            workspaceId: 'w1',
            workspaceName: 'feature',
        });
    });
});
