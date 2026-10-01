/**
 * `happy daemon start` used to give the spawned `daemon start-sync` a fixed 5s to write its state.
 * On a slow Windows PC the daemon wrote it at 6.9s (2026-10-01), so start printed "Failed to start
 * daemon" while a healthy daemon came up behind it, and Desktop setup rolled it back. Wait until the
 * daemon is running, start-sync has failed, or the timeout passes. start-sync exits 0 when it loses
 * the lock to another starting daemon (run.ts), so a clean exit keeps waiting for that winner.
 */
export async function waitForDaemonStart(
    deps: {
        isRunning: () => Promise<boolean>;
        /** undefined while start-sync runs; its exit code after (null when a signal ended it). */
        childExit: () => number | null | undefined;
        now: () => number;
        sleep: (ms: number) => Promise<void>;
    },
    options: { timeoutMs: number; pollMs: number },
): Promise<'started' | 'exited' | 'timeout'> {
    const deadline = deps.now() + options.timeoutMs;
    for (;;) {
        if (await deps.isRunning()) return 'started';
        const code = deps.childExit();
        if (code !== undefined && code !== 0) return 'exited';
        if (deps.now() >= deadline) return 'timeout';
        await deps.sleep(options.pollMs);
    }
}
