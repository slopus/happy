import type { TrackedSession } from './types';

export async function findRunningTrackedSessionById(opts: {
    sessions: Iterable<TrackedSession>;
    happySessionId: string;
    isPidAlive: (pid: number) => Promise<boolean>;
    getProcessCommandHash: (pid: number) => Promise<string | null>;
}): Promise<TrackedSession | null> {
    const target = opts.happySessionId.trim();
    if (!target) return null;

    for (const s of opts.sessions) {
        if (s.happySessionId !== target) continue;

        const alive = await opts.isPidAlive(s.pid);
        if (!alive) continue;

        // If we have a hash, require it to match to avoid PID reuse false positives.
        if (s.processCommandHash) {
            const current = await opts.getProcessCommandHash(s.pid);
            if (!current) continue;
            if (current !== s.processCommandHash) continue;
        }

        return s;
    }

    return null;
}
