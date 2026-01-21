export function ensureRemoteStartingModeArgs(argv: string[]): string[] {
  const idx = argv.indexOf('--happy-starting-mode');
  if (idx === -1) {
    return [...argv, '--happy-starting-mode', 'remote'];
  }

  const value = argv[idx + 1];
  if (value === 'remote') return argv;
  if (value === 'local') {
    throw new Error('Headless tmux sessions require remote mode');
  }

  // Unknown value: preserve but keep behavior consistent by failing closed.
  throw new Error('Headless tmux sessions require remote mode');
}

