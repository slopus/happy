import type { TerminalMode } from './terminalConfig';

export type TerminalRuntimeFlags = {
  mode?: TerminalMode;
  requested?: TerminalMode;
  fallbackReason?: string;
  tmuxTarget?: string;
  tmuxTmpDir?: string;
};

function parseTerminalMode(value: string | undefined): TerminalMode | undefined {
  if (value === 'plain' || value === 'tmux') return value;
  return undefined;
}

export function parseAndStripTerminalRuntimeFlags(argv: string[]): {
  terminal: TerminalRuntimeFlags | null;
  argv: string[];
} {
  const terminal: TerminalRuntimeFlags = {};
  const remaining: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--happy-terminal-mode') {
      terminal.mode = parseTerminalMode(argv[++i]);
      continue;
    }
    if (arg === '--happy-terminal-requested') {
      terminal.requested = parseTerminalMode(argv[++i]);
      continue;
    }
    if (arg === '--happy-terminal-fallback-reason') {
      const value = argv[++i];
      if (typeof value === 'string' && value.trim().length > 0) {
        terminal.fallbackReason = value;
      }
      continue;
    }
    if (arg === '--happy-tmux-target') {
      const value = argv[++i];
      if (typeof value === 'string' && value.trim().length > 0) {
        terminal.tmuxTarget = value;
      }
      continue;
    }
    if (arg === '--happy-tmux-tmpdir') {
      const value = argv[++i];
      if (typeof value === 'string' && value.trim().length > 0) {
        terminal.tmuxTmpDir = value;
      }
      continue;
    }

    remaining.push(arg);
  }

  const hasAny =
    terminal.mode !== undefined ||
    terminal.requested !== undefined ||
    terminal.fallbackReason !== undefined ||
    terminal.tmuxTarget !== undefined ||
    terminal.tmuxTmpDir !== undefined;

  return { terminal: hasAny ? terminal : null, argv: remaining };
}

