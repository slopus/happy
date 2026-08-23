import type { NewSessionAgentType } from '@/sync/persistence';

/**
 * The coding agents Happy can start a session with, and what to call them in
 * the UI. `rig` is the wire/CLI id of Happy's own agent; it is only ever shown
 * as "Happy". `agy` is Antigravity's binary name for the same reason.
 */
export const HARNESS_NAMES: Record<NewSessionAgentType, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    rig: 'Happy',
    agy: 'Antigravity',
    gemini: 'Gemini',
    openclaw: 'OpenClaw',
};

/**
 * Harnesses you can no longer start a session with.
 *
 * Gemini's CLI login is dead for individual accounts — it now refuses with
 * "This client is no longer supported […] migrate to the Antigravity suite",
 * which is the `agy` harness. OpenClaw is shelved for now. Both stay in
 * HARNESS_NAMES so an existing session still shows a real product name, and
 * neither is removed from the CLI, the wire, or the transcript renderers.
 */
export const RETIRED_HARNESSES: ReadonlySet<NewSessionAgentType> = new Set([
    'gemini',
    'openclaw',
]);

/** Pick order for every harness list: the ones people reach for come first. */
export const HARNESS_ORDER: readonly NewSessionAgentType[] = [
    'claude',
    'codex',
    'agy',
    'rig',
];

export function isRetiredHarness(key: NewSessionAgentType | string): boolean {
    return RETIRED_HARNESSES.has(key as NewSessionAgentType);
}

export type HarnessAvailability = Partial<Record<NewSessionAgentType, boolean>>;

export type HarnessOption = {
    key: NewSessionAgentType;
    name: string;
};

export function getHarnessName(key: NewSessionAgentType | string): string {
    return HARNESS_NAMES[key as NewSessionAgentType] ?? key;
}

/**
 * The harnesses a machine actually has set up, in pick order.
 *
 * A harness with no CLI on the machine is left out rather than shown disabled:
 * a greyed-out row reads as something you can turn on from here, and you
 * cannot. Two things keep the list from ever being empty — the current
 * selection is always included, and a machine that reports no capabilities at
 * all (an older daemon, or none selected yet) falls back to the whole catalog.
 * A retired harness is exempt from the first of those: keeping it listed is
 * what would strand someone on it.
 */
export function listAvailableHarnesses({
    availability,
    happyAgentAvailable,
    selected,
}: {
    availability?: HarnessAvailability | null;
    happyAgentAvailable: boolean;
    selected?: NewSessionAgentType | null;
}): HarnessOption[] {
    const isAvailable = (key: NewSessionAgentType) => (
        // Happy's own agent runs on a machine of its own, so its availability
        // is resolved from the machine catalog rather than this machine's CLIs.
        key === 'rig' ? happyAgentAvailable : !availability || availability[key] === true
    );
    const keys = HARNESS_ORDER.filter((key) => key === selected || isAvailable(key));
    return (keys.length > 0 ? keys : HARNESS_ORDER).map((key) => ({
        key,
        name: HARNESS_NAMES[key],
    }));
}
