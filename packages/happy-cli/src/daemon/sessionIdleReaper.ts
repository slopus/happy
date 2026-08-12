import type { TrackedSession } from './types';

export type IdleReaperResult = {
    stopped: number;
    errors: string[];
};

async function mapWithConcurrency<T>(
    values: T[],
    concurrency: number,
    worker: (value: T) => Promise<void>,
): Promise<void> {
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (nextIndex < values.length) {
            const value = values[nextIndex];
            nextIndex += 1;
            await worker(value);
        }
    });
    await Promise.all(workers);
}

export async function reapIdleDaemonSessions({
    sessions,
    timeoutMs,
    fetchLatestMessageAt,
    isCurrent,
    deactivateSession,
    stopSession,
    now = Date.now,
    fetchConcurrency = 5,
}: {
    sessions: TrackedSession[];
    timeoutMs: number;
    fetchLatestMessageAt: (sessionId: string) => Promise<number | null>;
    isCurrent: (session: TrackedSession) => boolean;
    deactivateSession: (sessionId: string) => Promise<boolean>;
    stopSession: (sessionId: string) => Promise<boolean>;
    now?: () => number;
    fetchConcurrency?: number;
}): Promise<IdleReaperResult> {
    const result: IdleReaperResult = { stopped: 0, errors: [] };
    const candidates = sessions.filter((session) => (
        session.startedBy === 'daemon'
        && session.startedAt !== undefined
    ));

    await mapWithConcurrency(candidates, Math.max(1, fetchConcurrency), async (session) => {
        let latestMessageAt: number | null = null;
        if (session.happySessionId) {
            try {
                latestMessageAt = await fetchLatestMessageAt(session.happySessionId);
            } catch (error) {
                // Resource cleanup must fail open when activity cannot be checked.
                result.errors.push(`${session.happySessionId}: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
        }

        const lastActivityAt = Math.max(session.startedAt!, latestMessageAt ?? 0);
        if (now() - lastActivityAt < timeoutMs) {
            return;
        }

        // Re-read the newest timestamp immediately before stopping to narrow the
        // race with a message arriving during the periodic scan.
        if (session.happySessionId) {
            try {
                const recheckedMessageAt = await fetchLatestMessageAt(session.happySessionId);
                const recheckedActivityAt = Math.max(session.startedAt!, recheckedMessageAt ?? 0);
                if (now() - recheckedActivityAt < timeoutMs) {
                    return;
                }
            } catch (error) {
                result.errors.push(`${session.happySessionId}: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
        }

        if (!isCurrent(session)) {
            return;
        }

        if (session.happySessionId) {
            try {
                const deactivated = await deactivateSession(session.happySessionId);
                if (!deactivated) {
                    result.errors.push(`${session.happySessionId}: failed to mark session inactive before stopping`);
                    return;
                }
            } catch (error) {
                result.errors.push(`${session.happySessionId}: failed to mark session inactive: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
        }

        const stopped = await stopSession(session.happySessionId ?? `PID-${session.pid}`);
        if (stopped) {
            result.stopped += 1;
        }
    });

    return result;
}
