import { describe, expect, it } from 'vitest';
import { parseAndStripTerminalRuntimeFlags } from './terminalRuntimeFlags';

describe('parseAndStripTerminalRuntimeFlags', () => {
  it('extracts tmux runtime info and strips internal flags from argv', () => {
    const parsed = parseAndStripTerminalRuntimeFlags([
      'claude',
      '--happy-terminal-mode',
      'tmux',
      '--happy-tmux-target',
      'happy:win-123',
      '--happy-tmux-tmpdir',
      '/tmp/happy-tmux',
      '--model',
      'sonnet',
    ]);

    expect(parsed).toEqual({
      terminal: {
        mode: 'tmux',
        tmuxTarget: 'happy:win-123',
        tmuxTmpDir: '/tmp/happy-tmux',
      },
      argv: ['claude', '--model', 'sonnet'],
    });
  });

  it('extracts fallback info when tmux was requested but plain mode was used', () => {
    const parsed = parseAndStripTerminalRuntimeFlags([
      '--happy-terminal-mode',
      'plain',
      '--happy-terminal-requested',
      'tmux',
      '--happy-terminal-fallback-reason',
      'tmux not available',
      '--foo',
      'bar',
    ]);

    expect(parsed).toEqual({
      terminal: {
        mode: 'plain',
        requested: 'tmux',
        fallbackReason: 'tmux not available',
      },
      argv: ['--foo', 'bar'],
    });
  });
});

