export type AcpAgentConfig = {
  command: string;
  args: string[];
};

export const KNOWN_ACP_AGENTS: Record<string, AcpAgentConfig> = {
  gemini: { command: 'gemini', args: ['--experimental-acp'] },
  opencode: { command: 'opencode', args: ['acp'] },
};

export type ResolvedAcpAgentConfig = {
  agentName: string;
  command: string;
  args: string[];
};

/**
 * Happy-internal CLI flags that the daemon injects when spawning an ACP agent
 * (e.g. `--happy-starting-mode remote`, `--dangerously-skip-permissions`).
 * These belong to happy's own argv and must NOT be forwarded to the underlying
 * agent: yargs-based agents (opencode, gemini) treat unknown options as fatal
 * and exit 1 before the ACP handshake completes.
 */
const HAPPY_INTERNAL_FLAG_PREFIXES = ['--happy-', '--dangerously-'] as const;
const HAPPY_INTERNAL_VALUE_FLAGS = ['--happy-starting-mode', '--permission-mode'] as const;

function isHappyInternalFlag(arg: string): boolean {
  return (
    HAPPY_INTERNAL_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix)) ||
    (HAPPY_INTERNAL_VALUE_FLAGS as readonly string[]).includes(arg)
  );
}

/**
 * Strip happy-internal flags from an argv slice. Value-bearing flags
 * (`--happy-starting-mode <val>`, `--permission-mode <val>`) consume their
 * following token too, unless that token itself starts with `-` (i.e. it is
 * another flag, meaning the value was already missing).
 */
function filterHappyInternalFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (isHappyInternalFlag(arg)) {
      if (
        (HAPPY_INTERNAL_VALUE_FLAGS as readonly string[]).includes(arg) &&
        i + 1 < args.length &&
        !args[i + 1].startsWith('-')
      ) {
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

export function resolveAcpAgentConfig(cliArgs: string[]): ResolvedAcpAgentConfig {
  if (cliArgs.length === 0) {
    throw new Error('Usage: happy acp <agent-name> or happy acp -- <command> [args]');
  }

  if (cliArgs[0] === '--') {
    const command = cliArgs[1];
    if (!command) {
      throw new Error('Missing command after "--". Usage: happy acp -- <command> [args]');
    }
    // Explicit `--` separator form: user owns the full argv, do not filter.
    return {
      agentName: command,
      command,
      args: cliArgs.slice(2),
    };
  }

  const agentName = cliArgs[0];
  const known = KNOWN_ACP_AGENTS[agentName];
  if (known) {
    const passthroughArgs = filterHappyInternalFlags(
      cliArgs
        .slice(1)
        // Backward-compatible with old OpenCode docs/flags.
        .filter((arg) => !(agentName === 'opencode' && arg === '--acp')),
    );
    return {
      agentName,
      command: known.command,
      args: [...known.args, ...passthroughArgs],
    };
  }

  return {
    agentName,
    command: agentName,
    args: filterHappyInternalFlags(cliArgs.slice(1)),
  };
}
