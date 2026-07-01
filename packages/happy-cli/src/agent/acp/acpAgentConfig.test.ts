import { describe, expect, it } from 'vitest';
import { KNOWN_ACP_AGENTS, resolveAcpAgentConfig } from './acpAgentConfig';

describe('KNOWN_ACP_AGENTS', () => {
  it('defines built-in Gemini and OpenCode command mappings', () => {
    expect(KNOWN_ACP_AGENTS).toEqual({
      gemini: { command: 'gemini', args: ['--experimental-acp'] },
      opencode: { command: 'opencode', args: ['acp'] },
    });
  });
});

describe('resolveAcpAgentConfig', () => {
  it('resolves known agent names to predefined command + args', () => {
    expect(resolveAcpAgentConfig(['gemini'])).toEqual({
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });
  });

  it('appends extra CLI args for known agent aliases', () => {
    expect(resolveAcpAgentConfig(['opencode', '--foo'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });

  it('strips legacy --acp for opencode compatibility', () => {
    expect(resolveAcpAgentConfig(['opencode', '--acp', '--foo'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });

  it('resolves custom command form with -- separator', () => {
    expect(resolveAcpAgentConfig(['--', 'custom-agent', '--flag'])).toEqual({
      agentName: 'custom-agent',
      command: 'custom-agent',
      args: ['--flag'],
    });
  });

  it('treats unknown agent names as direct commands', () => {
    expect(resolveAcpAgentConfig(['my-agent', '--x'])).toEqual({
      agentName: 'my-agent',
      command: 'my-agent',
      args: ['--x'],
    });
  });

  it('throws with helpful usage when no args are provided', () => {
    expect(() => resolveAcpAgentConfig([])).toThrow('Usage: happy acp <agent-name> or happy acp -- <command> [args]');
  });

  it('throws when separator form omits command', () => {
    expect(() => resolveAcpAgentConfig(['--'])).toThrow('Missing command after "--". Usage: happy acp -- <command> [args]');
  });
});

describe('resolveAcpAgentConfig happy-internal flag stripping', () => {
  it('strips daemon-injected flags from opencode spawn (regression: yargs exit 1)', () => {
    expect(
      resolveAcpAgentConfig([
        'opencode',
        '--happy-starting-mode',
        'remote',
        '--dangerously-skip-permissions',
      ]),
    ).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });
  });

  it('preserves real user args while stripping happy flags for known agents', () => {
    expect(
      resolveAcpAgentConfig([
        'opencode',
        '--foo',
        '--happy-starting-mode',
        'remote',
        '--bar',
      ]),
    ).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo', '--bar'],
    });
  });

  it('strips boolean --dangerously-* flags for gemini', () => {
    expect(resolveAcpAgentConfig(['gemini', '--dangerously-skip-permissions', '--x'])).toEqual({
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp', '--x'],
    });
  });

  it('strips value-bearing --permission-mode and its value', () => {
    expect(resolveAcpAgentConfig(['opencode', '--permission-mode', 'acceptEdits', '--z'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--z'],
    });
  });

  it('does not consume the next token when a value flag is followed by another flag', () => {
    expect(
      resolveAcpAgentConfig(['opencode', '--happy-starting-mode', '--next-flag']),
    ).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--next-flag'],
    });
  });

  it('strips happy flags for unknown agent names too', () => {
    expect(
      resolveAcpAgentConfig(['my-agent', '--happy-starting-mode', 'remote', '--foo']),
    ).toEqual({
      agentName: 'my-agent',
      command: 'my-agent',
      args: ['--foo'],
    });
  });

  it('preserves happy-prefixed args after explicit -- separator (user owns argv)', () => {
    expect(resolveAcpAgentConfig(['--', 'custom-agent', '--happy-x'])).toEqual({
      agentName: 'custom-agent',
      command: 'custom-agent',
      args: ['--happy-x'],
    });
  });
});
