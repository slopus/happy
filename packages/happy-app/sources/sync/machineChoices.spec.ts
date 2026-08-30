import { describe, expect, it } from 'vitest';
import {
    collectMachineChoices,
    findMachineChoice,
    machineChoiceAgentAvailable,
    machineChoiceAgentVisible,
    resolveAgentMachine,
    resolveChoiceAgent,
    resolveWorktreeCreationMachine,
} from './machineChoices';
import type { Machine } from './storageTypes';

function machine(
    id: string,
    metadata: Record<string, unknown>,
    options: { active?: boolean; activeAt?: number } = {},
): Machine {
    return {
        id,
        metadata,
        active: options.active ?? true,
        activeAt: options.activeAt ?? 0,
    } as unknown as Machine;
}

const CLI = 'cli-machine';
const RIG = 'rig-machine';

function cli(id = CLI, options?: { active?: boolean; activeAt?: number }) {
    return machine(id, {
        host: 'laptop.local',
        cliAvailability: { claude: true, codex: true, gemini: false, openclaw: false },
    }, options);
}

function rig(id = RIG, sibling = CLI, options?: { active?: boolean; activeAt?: number }) {
    return machine(id, {
        host: 'laptop.local',
        displayName: 'laptop.local — Happy Agent',
        machineKind: 'rig',
        rigOnly: true,
        siblingMachineId: sibling,
        capabilities: { newSession: true },
    }, options);
}

describe('offering one computer rather than one daemon', () => {
    it('collapses a Happy CLI and Happy Agent pair into a single choice', () => {
        const choices = collectMachineChoices([cli(), rig()]);
        expect(choices).toHaveLength(1);
        expect(choices[0].machineIds.sort()).toEqual([CLI, RIG].sort());
    });

    it('names the computer by its host, dropping the Happy Agent suffix', () => {
        expect(collectMachineChoices([cli(), rig()])[0].name).toBe('laptop.local');
    });

    it('stores the Happy CLI machine id, which is what older drafts already hold', () => {
        expect(collectMachineChoices([cli(), rig()])[0].id).toBe(CLI);
    });

    it('leaves two unpaired computers apart even when they share a host name', () => {
        const choices = collectMachineChoices([cli('one'), cli('two')]);
        expect(choices).toHaveLength(2);
    });

    it('offers a Happy Agent with no Happy CLI beside it, under its own host name', () => {
        const choices = collectMachineChoices([rig(RIG, 'missing-sibling')]);
        expect(choices).toHaveLength(1);
        expect(choices[0].name).toBe('laptop.local');
        expect(choices[0].id).toBe(RIG);
    });

    it('finds the computer from either of its machine ids', () => {
        const choices = collectMachineChoices([cli(), rig()]);
        expect(findMachineChoice(choices, RIG)?.id).toBe(CLI);
        expect(findMachineChoice(choices, CLI)?.id).toBe(CLI);
    });
});

describe('choosing between several Happy Agent registrations on one computer', () => {
    // A daemon started from another data directory mints a new machine and claims the same
    // sibling, so one computer can carry a live registration and several dead ones.
    const stale = rig('stale-rig', CLI, { active: false, activeAt: 500 });
    const live = rig('live-rig', CLI, { active: true, activeAt: 100 });
    const recent = rig('recent-rig', CLI, { active: false, activeAt: 900 });

    it('talks to the one that is reachable', () => {
        const choice = collectMachineChoices([cli(), stale, live, recent])[0];
        expect(choice.rigMachine?.id).toBe('live-rig');
    });

    it('falls back to the most recently seen when none are reachable', () => {
        const choice = collectMachineChoices([cli(), stale, recent])[0];
        expect(choice.rigMachine?.id).toBe('recent-rig');
    });

    // Machines arrive newest first, and a Happy Agent registration is younger than the Happy CLI
    // it points at, so in practice every agent is seen before the computer they have in common.
    it('is one computer even when the agents are seen before what they point at', () => {
        const choices = collectMachineChoices([recent, stale, cli()]);

        expect(choices).toHaveLength(1);
        expect(choices[0].machineIds).toHaveLength(3);
        expect(choices[0].happyMachine?.id).toBe(CLI);
    });

    it('never lets one machine belong to two computers', () => {
        const seen = new Set<string>();
        for (const choice of collectMachineChoices([recent, stale, cli()])) {
            for (const id of choice.machineIds) {
                expect(seen.has(id)).toBe(false);
                seen.add(id);
            }
        }
    });
});

describe('what a computer can actually run', () => {
    it('offers Happy Agent only where a Happy Agent daemon is registered', () => {
        const paired = collectMachineChoices([cli(), rig()])[0];
        const alone = collectMachineChoices([cli()])[0];
        expect(machineChoiceAgentAvailable(paired, 'rig')).toBe(true);
        expect(machineChoiceAgentAvailable(alone, 'rig')).toBe(false);
    });

    it('refuses a CLI agent on a computer that runs only Happy Agent', () => {
        const choice = collectMachineChoices([rig(RIG, 'missing-sibling')])[0];
        expect(machineChoiceAgentAvailable(choice, 'claude')).toBe(false);
        expect(machineChoiceAgentAvailable(choice, 'rig')).toBe(true);
    });

    it('believes a CLI that reports nothing, rather than assuming it has everything', () => {
        const choice = collectMachineChoices([machine('bare', { host: 'old.local' })])[0];
        expect(machineChoiceAgentAvailable(choice, 'claude')).toBe(true);
        expect(machineChoiceAgentAvailable(choice, 'agy')).toBe(false);
        expect(machineChoiceAgentAvailable(choice, 'rig')).toBe(false);
    });

    it('only shows Antigravity and Happy Agent when available on the machine', () => {
        const absent = collectMachineChoices([cli()])[0];
        const paired = collectMachineChoices([cli(), rig()])[0];
        const installed = collectMachineChoices([machine('agy-machine', {
            host: 'laptop.local',
            cliAvailability: { claude: true, agy: true },
        })])[0];

        expect(machineChoiceAgentVisible(absent, 'agy')).toBe(false);
        expect(machineChoiceAgentVisible(installed, 'agy')).toBe(true);
        expect(machineChoiceAgentVisible(absent, 'claude')).toBe(true);
        expect(machineChoiceAgentVisible(absent, 'rig')).toBe(false);
        expect(machineChoiceAgentVisible(paired, 'rig')).toBe(true);
    });

    it('keeps a stale draft from starting an agent this computer cannot run', () => {
        const rigOnly = collectMachineChoices([rig(RIG, 'missing-sibling')])[0];
        expect(resolveChoiceAgent(rigOnly, 'claude')).toBe('rig');
        const cliOnly = collectMachineChoices([cli()])[0];
        expect(resolveChoiceAgent(cliOnly, 'rig')).toBe('claude');
        expect(resolveChoiceAgent(cliOnly, 'gemini')).toBe('claude');
    });

    it('sends each agent to the daemon that runs it', () => {
        const choice = collectMachineChoices([cli(), rig()])[0];
        expect(resolveAgentMachine(choice, 'rig')?.id).toBe(RIG);
        expect(resolveAgentMachine(choice, 'claude')?.id).toBe(CLI);
    });

    it('reports no daemon rather than handing the request to the wrong one', () => {
        const rigOnly = collectMachineChoices([rig(RIG, 'missing-sibling')])[0];
        expect(resolveAgentMachine(rigOnly, 'claude')).toBeNull();
    });
});

describe('choosing where to create a worktree', () => {
    it('uses Happy CLI for a Happy Agent workspace when the pair is online', () => {
        const choice = collectMachineChoices([cli(), rig()])[0];

        expect(resolveWorktreeCreationMachine(choice, 'rig', false)?.id).toBe(CLI);
    });

    it('uses Happy Agent directly when it supports worktrees and has no CLI pair', () => {
        const choice = collectMachineChoices([rig(RIG, 'missing-sibling')])[0];

        expect(resolveWorktreeCreationMachine(choice, 'rig', true)?.id).toBe(RIG);
    });

    it('does not bypass another harness worktree limitation', () => {
        const choice = collectMachineChoices([cli(), rig()])[0];

        expect(resolveWorktreeCreationMachine(choice, 'openclaw', false)).toBeNull();
    });

    it('does not offer an offline CLI as Happy Agent worktree support', () => {
        const choice = collectMachineChoices([
            cli(CLI, { active: false }),
            rig(RIG, CLI, { active: true }),
        ])[0];

        expect(resolveWorktreeCreationMachine(choice, 'rig', false)).toBeNull();
    });
});

describe('a computer that is asleep', () => {
    // Its projects have not moved, so it stays pickable and its Happy Agent stays selectable.
    const offline = collectMachineChoices([
        cli(CLI, { active: false, activeAt: 10 }),
        rig(RIG, CLI, { active: false, activeAt: 20 }),
    ])[0];

    it('is still offered, marked by when it was last seen', () => {
        expect(offline.online).toBe(false);
        expect(offline.activeAt).toBe(20);
    });

    it('still offers Happy Agent, which the send path refuses later with a reason', () => {
        expect(machineChoiceAgentAvailable(offline, 'rig')).toBe(true);
        expect(resolveAgentMachine(offline, 'rig')?.id).toBe(RIG);
    });
});
