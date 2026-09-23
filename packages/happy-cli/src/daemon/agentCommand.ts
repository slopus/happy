import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

export type SpawnableAgent = NonNullable<SpawnSessionOptions['agent']>;

/**
 * The CLI subcommand that starts each agent the daemon may spawn.
 *
 * Both spawn paths resolve through here. They used to decide independently —
 * the plain-process path with a switch that errored on an unknown agent, the
 * tmux path with a ternary chain that fell back to Claude. Adding an agent to
 * one and not the other started the wrong agent, silently, only on machines
 * that happen to have tmux.
 */
const AGENT_COMMANDS = {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
    openclaw: 'openclaw',
    agy: 'agy',
} as const satisfies Record<SpawnableAgent, string>;

export class UnsupportedAgentError extends Error {
    constructor(agent: string) {
        super(`Unsupported agent type: '${agent}'. Please update your CLI to the latest version.`);
        this.name = 'UnsupportedAgentError';
    }
}

/** Absent means Claude, which is the historical default of both spawn paths. */
export function resolveDaemonAgentCommand(agent: SpawnableAgent | undefined): string {
    if (agent === undefined) {
        return AGENT_COMMANDS.claude;
    }
    const command = (AGENT_COMMANDS as Record<string, string | undefined>)[agent];
    if (command === undefined) {
        throw new UnsupportedAgentError(agent);
    }
    return command;
}
