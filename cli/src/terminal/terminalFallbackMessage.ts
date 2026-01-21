import type { Metadata } from '@/api/types';

export function buildTerminalFallbackMessage(
  terminal: NonNullable<Metadata['terminal']>,
): string | null {
  if (terminal.mode !== 'plain') return null;
  if (terminal.requested !== 'tmux') return null;

  const reason =
    typeof terminal.fallbackReason === 'string' && terminal.fallbackReason.trim().length > 0
      ? ` Reason: ${terminal.fallbackReason.trim()}.`
      : '';

  return `This session couldn't be started in tmux, so "Attach from terminal" won't be available.${reason}`;
}

