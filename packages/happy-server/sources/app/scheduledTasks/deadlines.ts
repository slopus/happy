/** One-shot deadline timers. Long waits re-arm from memory without business-state reads. */
export function createDeadlineScheduler(onError: (error: unknown) => void = () => {}) {
    const entries = new Map<string, { timer?: ReturnType<typeof setTimeout>; at: number; work: () => Promise<unknown>; failed: boolean }>();
    let stopped = false;
    const cancel = (key: string) => { const entry = entries.get(key); if (entry?.timer) clearTimeout(entry.timer); entries.delete(key); };
    const schedule = (key: string, at: number, work: () => Promise<unknown>) => {
        cancel(key);
        if (stopped) return;
        const entry = { at, work, failed: false } as NonNullable<ReturnType<typeof entries.get>>;
        entries.set(key, entry);
        const arm = () => {
            const remaining = at - Date.now();
            const timer = setTimeout(() => {
                if (entries.get(key) !== entry || stopped) return;
                entry.timer = undefined;
                if (Date.now() < at) arm();
                else void work().then(() => {
                    if (entries.get(key) === entry) entries.delete(key);
                }).catch(error => {
                    if (entries.get(key) === entry) entry.failed = true;
                    onError(error);
                });
            }, Math.max(0, Math.min(remaining, 2_147_483_647)));
            entry.timer = timer;
        };
        arm();
    };
    return { schedule, cancel,
        retryFailed(prefix = '') {
            for (const [key, entry] of [...entries]) if (entry.failed && key.startsWith(prefix)) schedule(key, entry.at, entry.work);
        },
        stop() { stopped = true; for (const key of entries.keys()) cancel(key); } };
}
