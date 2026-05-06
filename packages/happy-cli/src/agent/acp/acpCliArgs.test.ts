import { describe, expect, it } from 'vitest';
import { resolveAcpAgentConfig } from './acpAgentConfig';
import { parseAcpCliArgs, parseOpenCodeCliArgs } from './acpCliArgs';

describe('parseAcpCliArgs', () => {
  it('consumes Happy-only flags before resolving generic OpenCode ACP args', () => {
    const parsed = parseAcpCliArgs(['opencode', '--started-by', 'daemon', '--happy-starting-mode', 'remote', '--verbose', '--foo']);

    expect(parsed).toEqual({
      startedBy: 'daemon',
      verbose: true,
      acpArgs: ['opencode', '--foo'],
    });
    expect(resolveAcpAgentConfig(parsed.acpArgs)).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });
});

describe('parseOpenCodeCliArgs', () => {
  it('resolves first-class OpenCode args without forwarding Happy-only flags', () => {
    const parsed = parseOpenCodeCliArgs(['--started-by', 'daemon', '--happy-starting-mode', 'remote', '--verbose', '--foo']);

    expect(parsed).toEqual({
      startedBy: 'daemon',
      verbose: true,
      acpArgs: ['opencode', '--foo'],
    });
    expect(resolveAcpAgentConfig(parsed.acpArgs)).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });
});
