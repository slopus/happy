/**
 * Helpers used to safely hand stdin back from an Ink-driven UI (e.g. the
 * remote-mode display) to the next interactive child process (e.g. local
 * `claude` running with stdio: 'inherit').
 *
 * Two failure modes we are guarding against on the remote→local switch:
 *
 *  1. Bytes that landed in stdin's read buffer while Ink owned it (extra
 *     spaces from the double-space confirmation, or anything typed during
 *     the brief "Switching to local mode…" delay) are still pending after
 *     Ink unmounts. The next process inherits the same fd and consumes
 *     them as if the user had typed them at the new prompt.
 *
 *  2. Once Ink calls setRawMode(false) on its componentWillUnmount, the
 *     terminal driver returns to cooked mode. Any keystroke that lands
 *     between Ink unmount and the child setting raw mode is *echoed by
 *     the kernel* at whatever screen position Ink last left the cursor —
 *     producing visible garbage (and what looks like a "second cursor")
 *     on top of the next process's UI.
 *
 * The cleanup keeps the terminal in raw mode for the whole drain window,
 * silently consumes any pending bytes, then pauses stdin. We deliberately
 * leave raw mode enabled on exit: the next consumer is an interactive
 * child process (claude) which will (re)set raw mode itself. This avoids
 * a cooked-mode race window between this cleanup and the child taking
 * over stdin via stdio: 'inherit'.
 */

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
     * Drain buffered input for this many ms. The terminal stays in raw mode
     * for this window so the kernel does not echo any keystrokes that arrive.
     */
    drainMs?: number;
    /**
     * If true (default), leave the terminal in raw mode after the drain.
     * The caller should immediately hand stdin to a process that itself
     * uses raw mode (e.g. claude code via stdio: 'inherit'). When false,
     * raw mode is restored to cooked at the end — use only when no raw-mode
     * consumer follows.
     */
    leaveRawMode?: boolean;
    /**
     * Optional debug sink so callers can log how much was drained.
     */
    onDebug?: (event: { kind: 'drain-byte-count'; bytes: number; chunks: number }) => void;
}): Promise<void> {
    const stdin = opts.stdin;
    if (!stdin.isTTY) return;

    const leaveRawMode = opts.leaveRawMode ?? true;

    // Re-assert raw mode for the duration of the drain. Ink's own unmount
    // path turns it off before we get here, so without this the kernel will
    // echo any pending or arriving keystrokes to the screen.
    try {
        stdin.setRawMode?.(true);
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
        if (!leaveRawMode) {
            try {
                stdin.setRawMode?.(false);
            } catch {
                // best-effort
            }
        }
        return;
    }

    let bytes = 0;
    let chunks = 0;
    const drainListener = (chunk: unknown) => {
        chunks++;
        if (typeof chunk === 'string') {
            bytes += Buffer.byteLength(chunk);
        } else if (chunk && typeof (chunk as Buffer).length === 'number') {
            bytes += (chunk as Buffer).length;
        }
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
        if (!leaveRawMode) {
            try {
                stdin.setRawMode?.(false);
            } catch {
                // best-effort
            }
        }
        opts.onDebug?.({ kind: 'drain-byte-count', bytes, chunks });
    }
}
