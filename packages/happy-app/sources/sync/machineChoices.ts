import type { NewSessionAgentType } from './persistence';
import type { Machine } from './storageTypes';
import { isRigMachine } from './rigSessionCreation';
import { pairedMachineIds } from './agentSessionPlaces';
import { isMachineOnline } from '@/utils/machineUtils';
import { isHarnessAvailable } from '@/utils/harnessCatalog';
import { NEW_SESSION_AGENT_ORDER, resolveMachineAgent } from '@/utils/newSessionAgentSelection';

/**
 * One computer, as a person picks it.
 *
 * Happy gives every daemon a machine of its own, so a computer running both Happy CLI and Happy
 * Agent arrives as two. Nobody thinks of their laptop that way. A choice is the laptop; which
 * daemon actually runs the session follows from the agent, underneath, without being asked.
 */
export interface MachineChoice {
    /**
     * What a draft stores, which is Happy CLI's machine whenever this computer has one.
     *
     * Happy Agent's display name carries a suffix that only means anything when both halves are on
     * screen at once, and drafts made before this pairing existed already hold the CLI machine.
     */
    id: string;
    name: string;
    /** Every machine on this computer, for reading the places on it. */
    machineIds: string[];
    /** The daemon Happy CLI runs here, if it runs one. */
    happyMachine: Machine | null;
    /** The daemon Happy Agent runs here, if it runs one. */
    rigMachine: Machine | null;
    /** True when any daemon on this computer is reachable. */
    online: boolean;
    activeAt: number;
}

export function getMachineName(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || 'Unknown machine';
}

/** Whichever of these is reachable, and failing that whichever was seen most recently. */
function preferLiveliest(machines: readonly Machine[]): Machine | null {
    return [...machines].sort((left, right) => (
        Number(isMachineOnline(right)) - Number(isMachineOnline(left))
        || (right.activeAt ?? 0) - (left.activeAt ?? 0)
    ))[0] ?? null;
}

/** The host name without the daemon suffix Happy Agent adds to tell the pair apart. */
function getComputerName(choice: { happyMachine: Machine | null; rigMachine: Machine | null }): string {
    const named = choice.happyMachine ?? choice.rigMachine;
    if (!named) return 'Unknown machine';
    // Happy Agent has no sibling to be distinguished from once the pair is offered as one row,
    // so it is named by its host rather than by the display name it publishes.
    if (choice.happyMachine === null && named.metadata?.host) return named.metadata.host;
    return getMachineName(named);
}

/**
 * Every machine reachable from this one by following the pairing pointer, in either direction.
 *
 * Pairing has to be followed all the way out rather than one hop, because the daemons of one
 * computer are only ever connected through the machine they have in common: two Happy Agent
 * registrations naming the same Happy CLI are the same laptop, but neither names the other. Asking
 * one hop from whichever machine was seen first splits that laptop in two and puts the Happy CLI
 * machine in both halves — and since machines arrive newest first, the agents really are seen
 * before the computer they point at.
 */
function connectedMachineIds(
    start: Machine,
    machines: readonly Machine[],
    byId: ReadonlyMap<string, Machine>,
): string[] {
    const found = new Set<string>([start.id]);
    const pending = [start];
    for (let machine = pending.pop(); machine !== undefined; machine = pending.pop()) {
        for (const id of pairedMachineIds(machine, machines)) {
            const paired = byId.get(id);
            if (paired === undefined || found.has(id)) continue;
            found.add(id);
            pending.push(paired);
        }
    }
    return [...found];
}

/**
 * The computers behind the machines, each offered once.
 *
 * A pairing is only ever the pointer Happy Agent publishes, read in both directions. Two daemons
 * that merely share a host name are left apart: they may be different accounts, different
 * containers, or the same folder opened twice, and merging them would start work in the wrong one.
 */
export function collectMachineChoices(machines: readonly Machine[]): MachineChoice[] {
    const byId = new Map(machines.map((machine) => [machine.id, machine]));
    const grouped = new Set<string>();
    const choices: MachineChoice[] = [];

    for (const machine of machines) {
        if (grouped.has(machine.id)) continue;
        const ids = connectedMachineIds(machine, machines, byId);
        for (const id of ids) grouped.add(id);
        const group = ids.map((id) => byId.get(id)!);
        // One computer can accumulate several Happy Agent registrations — a daemon started from a
        // different data directory mints a new machine identity and claims the same Happy CLI
        // machine as its sibling. The live one is the one to talk to, so reachability decides
        // first and recency breaks the tie; the stale ones are history and simply go unused.
        const rigMachine = preferLiveliest(group.filter((member) => isRigMachine(member.metadata)));
        const happyMachine = preferLiveliest(group.filter((member) => !isRigMachine(member.metadata)));
        choices.push({
            id: (happyMachine ?? rigMachine ?? machine).id,
            name: getComputerName({ happyMachine, rigMachine }),
            machineIds: ids,
            happyMachine,
            rigMachine,
            online: group.some(isMachineOnline),
            activeAt: Math.max(...group.map((member) => member.activeAt ?? 0)),
        });
    }

    return choices;
}

/** The computer a stored machine id belongs to, whichever of its daemons was stored. */
export function findMachineChoice(
    choices: readonly MachineChoice[],
    machineId: string | null | undefined,
): MachineChoice | null {
    if (!machineId) return null;
    return choices.find((choice) => choice.machineIds.includes(machineId)) ?? null;
}

/**
 * Whether this computer can run each agent right now.
 *
 * A computer with no Happy CLI daemon cannot run Claude Code however much the picker would like
 * to offer it, and Happy Agent's own machine publishes no CLI availability at all — so treating a
 * missing list as "everything is installed" is what let a person start a session the machine had
 * no way to honour.
 */
export function machineChoiceAgentAvailable(
    choice: MachineChoice | null,
    agent: NewSessionAgentType,
): boolean {
    if (!choice) return false;
    if (agent === 'rig') {
        return isHarnessAvailable({
            availability: choice.happyMachine?.metadata?.cliAvailability,
            happyAgentAvailable: choice.rigMachine !== null,
            key: agent,
        });
    }
    const happy = choice.happyMachine;
    if (!happy) return false;
    return isHarnessAvailable({
        availability: happy.metadata?.cliAvailability,
        happyAgentAvailable: choice.rigMachine !== null,
        key: agent,
    });
}

/**
 * Whether the Home picker should contain this harness at all.
 *
 * Common harnesses stay visible but disabled when unavailable. Antigravity and
 * Happy Agent stay absent until this computer reports them available.
 */
export function machineChoiceAgentVisible(
    choice: MachineChoice | null,
    agent: NewSessionAgentType,
): boolean {
    return (agent !== 'agy' && agent !== 'rig') || machineChoiceAgentAvailable(choice, agent);
}

/**
 * The agent this computer can really run, given what the draft asked for.
 *
 * A draft outlives the machine it was made against: an app upgrade, a daemon that went away, or
 * simply picking another computer. Resolving again at the point of use is what keeps the picker
 * and the send button agreeing about what is about to happen.
 */
export function resolveChoiceAgent(
    choice: MachineChoice | null,
    agent: NewSessionAgentType,
): NewSessionAgentType {
    if (!choice) return agent;
    if (machineChoiceAgentAvailable(choice, agent)) {
        // Older Happy CLI machines are trusted for common harnesses. Antigravity
        // never reaches this branch without an explicit installation report.
        return agent === 'rig' || !choice.happyMachine?.metadata?.cliAvailability
            ? agent
            : resolveMachineAgent(agent, choice.happyMachine.metadata.cliAvailability);
    }
    return NEW_SESSION_AGENT_ORDER.find((candidate) => machineChoiceAgentAvailable(choice, candidate))
        ?? agent;
}

/**
 * Resolve the harness a new-session surface may offer and launch.
 *
 * Happy's own harness remains fully supported for existing sessions and sync,
 * but session creation is experimental. A saved Happy draft therefore falls
 * back to the first regular harness while experiments are disabled. Falling
 * back even when a computer only has Happy registered keeps the hidden harness
 * from being launched through a stale draft; the normal missing-daemon check
 * then explains why the regular harness cannot start on that computer.
 */
export function resolveNewSessionAgent(
    choice: MachineChoice | null,
    agent: NewSessionAgentType,
    experiments: boolean,
): NewSessionAgentType {
    const resolved = resolveChoiceAgent(choice, agent);
    if (experiments || resolved !== 'rig') return resolved;

    return NEW_SESSION_AGENT_ORDER.find((candidate) => (
        candidate !== 'rig' && machineChoiceAgentAvailable(choice, candidate)
    )) ?? NEW_SESSION_AGENT_ORDER.find((candidate) => candidate !== 'rig') ?? resolved;
}

/**
 * The daemon that runs this agent on this computer.
 *
 * Null is a refusal: a computer without the daemon an agent needs is told so, rather than having
 * the request quietly handed to the other one.
 */
export function resolveAgentMachine(
    choice: MachineChoice | null,
    agent: NewSessionAgentType,
): Machine | null {
    if (!choice) return null;
    return agent === 'rig' ? choice.rigMachine : choice.happyMachine;
}
