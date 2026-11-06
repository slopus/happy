import { readFileSync } from 'node:fs';
import type { PersistedSession } from '@/persistence';

function readProcStatus(pid: number): string {
    return readFileSync(`/proc/${pid}/status`, 'utf8');
}

// On Linux kill(tid, 0) succeeds for any thread ID, so a saved PID that was
// reused as a thread of an unrelated process still looks alive. A real process
// is its own thread group leader (Tgid === pid).
function isThreadOfAnotherProcess(pid: number, readStatus: (pid: number) => string): boolean {
    if (process.platform !== 'linux') return false;
    try {
        const tgid = /^Tgid:\s*(\d+)$/m.exec(readStatus(pid));
        return tgid !== null && Number(tgid[1]) !== pid;
    } catch {
        return false; // unreadable /proc proves nothing; keep the kill() verdict
    }
}

// Adapted from chphch's PR #1715. Only ESRCH proves absence: permission errors
// must not permit a second owner, and a saved PID is never authority to kill.
export function isPidAlive(
    pid: number | undefined,
    kill: (pid: number, signal: 0) => void = process.kill,
    readStatus: (pid: number) => string = readProcStatus,
): boolean {
    if (!Number.isSafeInteger(pid) || pid! <= 0) return false;
    try {
        kill(pid!, 0);
        return !isThreadOfAnotherProcess(pid!, readStatus);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

export function machineBootTimeMs(uptimeSeconds: number, nowMs: number): number {
    return nowMs - uptimeSeconds * 1000;
}

/** A live saved PID is a possible conflict, not verified session ownership. */
export function hasPersistedProcessConflict(session: PersistedSession | undefined, bootTimeMs: number): boolean {
    if (!session || session.savedAt < bootTimeMs) return false;
    return isPidAlive(session.metadata?.hostPid);
}