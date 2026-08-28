import { describe, expect, it } from 'vitest';
import {
    collectSessionPlaces,
    collectSessionWorkspaces,
    pairedMachineIds,
} from './agentSessionPlaces';
import type { Machine, Session } from './storageTypes';

function session(metadata: Record<string, unknown>): Session {
    return { id: `s${Math.random()}`, metadata } as unknown as Session;
}

function machine(id: string, metadata: Record<string, unknown> = {}): Machine {
    return { id, metadata } as unknown as Machine;
}

const RIG = 'rig-machine';
const CLI = 'cli-machine';

describe('where a Happy Agent session may be started', () => {
    it('offers the directories legacy sessions established, on either machine of the pair', () => {
        const places = collectSessionPlaces({
            machineIds: [RIG, CLI],
            sessions: [
                session({ machineId: CLI, path: '/home/steve/projects/happy' }),
                session({ machineId: RIG, path: '/home/steve/projects/rig' }),
            ],
        });
        expect(places.map((p) => p.path).sort()).toEqual([
            '/home/steve/projects/happy',
            '/home/steve/projects/rig',
        ]);
    });

    it('prefers the project name Happy Agent knows over the bare path', () => {
        const places = collectSessionPlaces({
            machineIds: [RIG, CLI],
            sessions: [
                session({ machineId: CLI, path: '/home/steve/projects/rig' }),
                session({
                    machineId: RIG,
                    path: '/home/steve/projects/rig',
                    project: { id: 'project-7', kind: 'regular', name: 'rig' },
                }),
            ],
        });
        expect(places).toHaveLength(1);
        expect(places[0]).toMatchObject({ name: 'rig', projectId: 'project-7' });
    });

    it('does not let a bare path overwrite a name already known', () => {
        const places = collectSessionPlaces({
            machineIds: [RIG, CLI],
            sessions: [
                session({
                    machineId: RIG,
                    path: '/home/steve/projects/rig',
                    project: { id: 'project-7', kind: 'regular', name: 'rig' },
                }),
                session({ machineId: CLI, path: '/home/steve/projects/rig' }),
            ],
        });
        expect(places[0]).toMatchObject({ name: 'rig', projectId: 'project-7' });
    });

    it('leaves out archived sessions, whose checkouts may be gone', () => {
        const places = collectSessionPlaces({
            machineIds: [RIG],
            sessions: [
                session({ machineId: RIG, path: '/home/steve/old', lifecycleState: 'archived' }),
                session({ machineId: RIG, path: '/home/steve/live' }),
            ],
        });
        expect(places.map((p) => p.path)).toEqual(['/home/steve/live']);
    });

    it('ignores machines that are not part of this computer', () => {
        const places = collectSessionPlaces({
            machineIds: [RIG],
            sessions: [session({ machineId: 'someone-elses-laptop', path: '/home/steve/x' })],
        });
        expect(places).toEqual([]);
    });

    it('always offers whatever is currently selected', () => {
        const places = collectSessionPlaces({
            machineIds: [RIG],
            selectedPath: '~',
            sessions: [],
        });
        expect(places.map((p) => p.path)).toEqual(['~']);
    });

    it('keeps a workspace out of the project list, since it is a checkout inside one', () => {
        const places = collectSessionPlaces({
            machineIds: [RIG],
            sessions: [
                session({
                    machineId: RIG,
                    path: '/home/steve/projects/rig/.worktrees/retry',
                    project: { id: 'project-7', kind: 'regular', name: 'rig' },
                    workspace: { id: 'w1', kind: 'worktree', name: 'Retry policy' },
                }),
            ],
        });
        expect(places).toEqual([]);
    });
});

describe('which workspaces a project offers', () => {
    const sessions = [
        session({
            machineId: RIG,
            path: '/home/steve/rig/.worktrees/retry',
            project: { id: 'project-7', kind: 'regular', name: 'rig' },
            workspace: { id: 'w1', kind: 'worktree', name: 'Retry policy rewrite' },
        }),
        session({
            machineId: RIG,
            path: '/home/steve/rig/.worktrees/old',
            lifecycleState: 'archived',
            project: { id: 'project-7', kind: 'regular', name: 'rig' },
            workspace: { id: 'w2', kind: 'worktree', name: 'Put away' },
        }),
        session({
            machineId: RIG,
            path: '/home/steve/other/.worktrees/x',
            project: { id: 'project-9', kind: 'regular', name: 'other' },
            workspace: { id: 'w3', kind: 'worktree', name: 'Elsewhere' },
        }),
    ];

    it('names each workspace by its title, not its branch', () => {
        const found = collectSessionWorkspaces({
            machineIds: [RIG],
            projectId: 'project-7',
            sessions,
        });
        expect(found.map((w) => w.name)).toEqual(['Retry policy rewrite']);
        expect(found[0].id).toBe('w1');
        expect(found[0].path).toBe('/home/steve/rig/.worktrees/retry');
    });

    it('offers nothing when no project is chosen', () => {
        expect(collectSessionWorkspaces({ machineIds: [RIG], sessions })).toEqual([]);
    });
});

describe('pairing the two machines of one computer', () => {
    it('reads the pointer Happy Agent writes', () => {
        const rig = machine(RIG, { siblingMachineId: CLI });
        expect(pairedMachineIds(rig, [rig, machine(CLI)]).sort()).toEqual([CLI, RIG].sort());
    });

    it('reads the pairing backwards, from the machine that was pointed at', () => {
        const cli = machine(CLI);
        const rig = machine(RIG, { siblingMachineId: CLI });
        expect(pairedMachineIds(cli, [cli, rig]).sort()).toEqual([CLI, RIG].sort());
    });

    it('is just the one machine when nothing is paired with it', () => {
        const cli = machine(CLI);
        expect(pairedMachineIds(cli, [cli])).toEqual([CLI]);
    });
});
