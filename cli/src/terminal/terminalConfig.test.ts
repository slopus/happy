import { describe, expect, it } from 'vitest';
import { resolveTerminalRequestFromSpawnOptions } from './terminalConfig';

describe('resolveTerminalRequestFromSpawnOptions', () => {
  it('prefers typed terminal config over legacy TMUX_* env vars', () => {
    const resolved = resolveTerminalRequestFromSpawnOptions({
      happyHomeDir: '/home/user/.happy',
      terminal: {
        mode: 'tmux',
        tmux: {
          sessionName: 'happy',
          isolated: true,
        },
      },
      environmentVariables: {
        TMUX_SESSION_NAME: 'legacy-session',
        TMUX_TMPDIR: '/tmp/legacy',
      },
    });

    expect(resolved).toEqual({
      requested: 'tmux',
      tmux: {
        sessionName: 'happy',
        isolated: true,
        tmpDir: '/home/user/.happy/tmux',
        source: 'typed',
      },
    });
  });

  it('derives TMUX_TMPDIR from happyHomeDir when isolated and tmpDir not provided', () => {
    const resolved = resolveTerminalRequestFromSpawnOptions({
      happyHomeDir: '/x/.happy',
      terminal: { mode: 'tmux', tmux: { sessionName: 'happy', isolated: true } },
      environmentVariables: {},
    });

    expect(resolved).toEqual({
      requested: 'tmux',
      tmux: {
        sessionName: 'happy',
        isolated: true,
        tmpDir: '/x/.happy/tmux',
        source: 'typed',
      },
    });
  });

  it('falls back to legacy TMUX_* env vars when typed terminal config is absent', () => {
    const resolved = resolveTerminalRequestFromSpawnOptions({
      happyHomeDir: '/home/user/.happy',
      environmentVariables: {
        TMUX_SESSION_NAME: '',
        TMUX_TMPDIR: '/tmp/custom',
      },
    });

    expect(resolved).toEqual({
      requested: 'tmux',
      tmux: {
        sessionName: '',
        isolated: false,
        tmpDir: '/tmp/custom',
        source: 'legacy',
      },
    });
  });

  it('returns requested=plain when terminal mode is plain', () => {
    const resolved = resolveTerminalRequestFromSpawnOptions({
      happyHomeDir: '/home/user/.happy',
      terminal: { mode: 'plain' },
      environmentVariables: { TMUX_SESSION_NAME: 'should-be-ignored' },
    });

    expect(resolved).toEqual({ requested: 'plain' });
  });
});

