/**
 * Auto-resume of interrupted sessions after a daemon restart.
 *
 * When the machine crashes, reboots, or the daemon is killed, previously
 * running sessions die with it. Their encrypted state is already persisted in
 * ~/.happy/sessions.json (see persistence.ts), and the daemon already knows
 * how to resume a session in-place via `resumeSession` (reusing the same Happy
 * session entity, so chat history and title are preserved).
 *
 * This module selects which persisted sessions should be automatically
 * resumed when the daemon starts:
 *
 *   - only sessions spawned by the daemon (terminal sessions are managed by
 *     the user and are intentionally left alone)
 *   - only sessions that were still running when the daemon last died
 *     (sessions that exited normally have `exitedAt` recorded)
 *   - only sessions whose process is actually gone (if only the daemon was
 *     restarted, the detached child may still be alive and will re-register
 *     itself via webhook)
 *   - only sessions that are resumable (they reported a claude session id or
 *     codex thread id, directly or via flavor detection later)
 *
 * Selection is a pure function so it can be unit tested.
 */

import type { PersistedSession } from '@/persistence';

export type AutoResumeCandidate = {
    sessionId: string;
    savedAt: number;
};

export type SelectAutoResumeCandidatesOptions = {
    /** Returns true when the given PID belongs to a live process. */
    isPidAlive: (pid: number) => boolean;
    /** Current time in ms. */
    now: number;
    /** Do not resume more than this many sessions (most recent first). */
    maxSessions: number;
    /** Ignore sessions persisted longer ago than this. */
    maxAgeMs: number;
};

export const AUTO_RESUME_DEFAULT_MAX_SESSIONS = 10;
export const AUTO_RESUME_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function selectAutoResumeCandidates(
    sessions: Record<string, PersistedSession>,
    options: SelectAutoResumeCandidatesOptions,
): AutoResumeCandidate[] {
    const candidates: AutoResumeCandidate[] = [];

    for (const [sessionId, session] of Object.entries(sessions)) {
        // Session exited under daemon supervision - not interrupted.
        if (session.exitedAt) {
            continue;
        }

        // Too old - user has most likely moved on.
        if (options.now - session.savedAt > options.maxAgeMs) {
            continue;
        }

        const metadata = session.metadata;
        if (!metadata) {
            continue;
        }

        // Only daemon-spawned sessions. Terminal sessions (started by the
        // user, possibly inside tmux) are intentionally not auto-resumed.
        if (!metadata.startedFromDaemon) {
            continue;
        }

        // If the process is still alive the session survived the daemon
        // restart. It will re-register itself - do not spawn a duplicate.
        if (metadata.hostPid && options.isPidAlive(metadata.hostPid)) {
            continue;
        }

        candidates.push({ sessionId, savedAt: session.savedAt });
    }

    // Most recently persisted sessions first, capped.
    candidates.sort((a, b) => b.savedAt - a.savedAt);
    return candidates.slice(0, options.maxSessions);
}

/** Signal-0 based liveness check, safe on all supported platforms. */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
