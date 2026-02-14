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

export function resolveAcpAgentConfig(cliArgs: string[]): ResolvedAcpAgentConfig {
  if (cliArgs.length === 0) {
    throw new Error('Usage: happy acp <agent-name> or happy acp -- <command> [args]');
  }

  if (cliArgs[0] === '--') {
    const command = cliArgs[1];
    if (!command) {
      throw new Error('Missing command after "--". Usage: happy acp -- <command> [args]');
    }
    return {
      agentName: command,
      command,
      args: cliArgs.slice(2),
    };
  }

  const agentName = cliArgs[0];
  const known = KNOWN_ACP_AGENTS[agentName];
  if (known) {
    const passthroughArgs = cliArgs
      .slice(1)
      // Backward-compatible with old OpenCode docs/flags.
      .filter((arg) => !(agentName === 'opencode' && arg === '--acp'));
    return {
      agentName,
      command: known.command,
      args: [...known.args, ...passthroughArgs],
    };
  }

  return {
    agentName,
    command: agentName,
    args: cliArgs.slice(1),
  };
}
