/**
 * `happy daemon start` used to give the spawned `daemon start-sync` a fixed 5s to write its state.
 * On a slow Windows PC the daemon wrote it at 6.9s (2026-10-01), so start printed "Failed to start
 * daemon" while a healthy daemon came up behind it, and Desktop setup rolled it back. Wait until the
 * daemon is running, the spawned process has exited, or the timeout passes.
 */
export async function waitForDaemonStart(
    deps: { isRunning: () => Promise<boolean>; childExited: () => boolean; now: () => number; sleep: (ms: number) => Promise<void> },
    options: { timeoutMs: number; pollMs: number },
): Promise<'started' | 'exited' | 'timeout'> {
    const deadline = deps.now() + options.timeoutMs;
    for (;;) {
        if (await deps.isRunning()) return 'started';
        if (deps.childExited()) return 'exited';
        if (deps.now() >= deadline) return 'timeout';
        await deps.sleep(options.pollMs);
    }
}
