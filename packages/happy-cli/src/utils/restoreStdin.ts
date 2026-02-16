/**
 * Restores process.stdin to a clean state after raw mode / Ink usage.
 *
 * When switching from remote mode (Ink UI with raw mode) back to local mode
 * (Claude with inherited stdio), stdin must be fully reset:
 *   1. Raw mode disabled (so the terminal handles line editing again)
 *   2. Paused (exits flowing mode so the child process can read stdin)
 *   3. Encoding reset from utf8 back to Buffer (setEncoding is sticky)
 *   4. Orphaned "data" listeners removed (prevents phantom keypress handling)
 *
 * Idempotent — safe to call multiple times or when stdin is already clean.
 */
export function restoreStdin(): void {
    try {
        // 1. Disable raw mode (only on TTY)
        if (process.stdin.isTTY) {
            try {
                process.stdin.setRawMode(false);
            } catch {
                // Already not in raw mode, or stdin is destroyed
            }
        }

        // 2. Pause stdin (exit flowing mode)
        try {
            process.stdin.pause();
        } catch {
            // Already paused or destroyed
        }

        // 3. Reset encoding back to Buffer mode
        //    setEncoding("utf8") is a one-way operation on the public API —
        //    the only way to undo it is to null out the internal decoder state.
        try {
            const state = (process.stdin as any)._readableState;
            if (state) {
                state.encoding = null;
                state.decoder = null;
            }
        } catch {
            // Internal state not accessible — non-critical
        }

        // 4. Remove orphaned "data" listeners that Ink or remote mode attached
        try {
            process.stdin.removeAllListeners('data');
        } catch {
            // Listeners already gone or stdin destroyed
        }
    } catch {
        // Entire restoration failed — non-critical, best-effort cleanup
    }
}
