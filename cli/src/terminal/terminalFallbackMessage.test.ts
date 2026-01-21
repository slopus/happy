import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import { buildTerminalFallbackMessage } from './terminalFallbackMessage';

describe('buildTerminalFallbackMessage', () => {
  it('returns null when tmux was not requested', () => {
    const terminal: NonNullable<Metadata['terminal']> = { mode: 'plain' };
    expect(buildTerminalFallbackMessage(terminal)).toBeNull();
  });

  it('returns a user-facing message when tmux was requested but we fell back to plain', () => {
    const terminal: NonNullable<Metadata['terminal']> = {
      mode: 'plain',
      requested: 'tmux',
      fallbackReason: 'tmux is not available on this machine',
    };

    expect(buildTerminalFallbackMessage(terminal)).toMatch('tmux');
    expect(buildTerminalFallbackMessage(terminal)).toMatch('tmux is not available on this machine');
  });
});

