export async function cleanupStdinAfterInk(opts: {
  stdin: {
    isTTY?: boolean;
    on: (event: 'data', listener: (chunk: unknown) => void) => unknown;
    off: (event: 'data', listener: (chunk: unknown) => void) => unknown;
    resume: () => void;
    pause: () => void;
    setRawMode?: (value: boolean) => void;
  };
  /**
   * Drain buffered input for this many ms after the UI unmounts.
   * This helps prevent users' “space spam” (used to switch modes) from being
   * delivered to the next interactive child process.
   */
  drainMs?: number;
}): Promise<void> {
  const stdin = opts.stdin;
  if (!stdin.isTTY) return;

  try {
    stdin.setRawMode?.(false);
  } catch {
    // best-effort
  }

  const drainMs = Math.max(0, opts.drainMs ?? 0);
  if (drainMs === 0) {
    try {
      stdin.pause();
    } catch {
      // best-effort
    }
    return;
  }

  const drainListener = () => {
    // Intentionally discard input.
  };

  try {
    stdin.on('data', drainListener);
    stdin.resume();
    await new Promise<void>((resolve) => setTimeout(resolve, drainMs));
  } finally {
    try {
      stdin.off('data', drainListener);
    } catch {
      // best-effort
    }
    try {
      stdin.pause();
    } catch {
      // best-effort
    }
  }
}

