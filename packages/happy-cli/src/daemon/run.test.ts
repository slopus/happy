import { describe, expect, it } from 'vitest';
import { resolveDaemonAgentCommand } from './run';

describe('resolveDaemonAgentCommand', () => {
  it('defaults missing agent to Claude', () => {
    expect(resolveDaemonAgentCommand()).toBe('claude');
  });

  it('resolves OpenCode for daemon-spawned sessions', () => {
    expect(resolveDaemonAgentCommand('opencode')).toBe('opencode');
  });

  it('keeps tmux and regular spawn command resolution on the same helper path', () => {
    expect(['claude', 'codex', 'gemini', 'openclaw', 'opencode'].map((agent) => (
      resolveDaemonAgentCommand(agent as Parameters<typeof resolveDaemonAgentCommand>[0])
    ))).toEqual(['claude', 'codex', 'gemini', 'openclaw', 'opencode']);
  });
});
