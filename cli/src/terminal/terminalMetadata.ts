import type { Metadata } from '@/api/types';

import type { TerminalRuntimeFlags } from './terminalRuntimeFlags';

export function buildTerminalMetadataFromRuntimeFlags(
  flags: TerminalRuntimeFlags | null,
): Metadata['terminal'] | undefined {
  if (!flags) return undefined;

  const mode = flags.mode;
  if (mode !== 'plain' && mode !== 'tmux') return undefined;

  const terminal: NonNullable<Metadata['terminal']> = {
    mode,
  };

  if (flags.requested === 'plain' || flags.requested === 'tmux') {
    terminal.requested = flags.requested;
  }
  if (typeof flags.fallbackReason === 'string' && flags.fallbackReason.trim().length > 0) {
    terminal.fallbackReason = flags.fallbackReason;
  }
  if (typeof flags.tmuxTarget === 'string' && flags.tmuxTarget.trim().length > 0) {
    terminal.tmux = {
      target: flags.tmuxTarget,
      ...(typeof flags.tmuxTmpDir === 'string' && flags.tmuxTmpDir.trim().length > 0
        ? { tmpDir: flags.tmuxTmpDir }
        : {}),
    };
  }

  return terminal;
}

