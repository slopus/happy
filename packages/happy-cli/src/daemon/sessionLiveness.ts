/**
 * Is a Happy session's process still running, and if so, is it still doing its
 * job?
 *
 * A Happy session is single-owner by construction: its message stream, its
 * metadata version and its agent-state version are all counters advanced by one
 * runtime. Spawning a second process for a session that already has one gives
 * the server two writers on those counters, and every user message is then
 * delivered to — and acted on by — both. So `resumeSession` has to answer this
 * question before it spawns anything.
 */

/**
 * Does this PID currently exist?
 *
 * `process.kill(pid, 0)` does not signal the target — signal 0 only performs the
 * permission-and-existence check, which is exactly the probe we want.
 */
export function isPidAlive(pid: number | undefined, kill: (pid: number, signal: 0) => void = process.kill): boolean {
    if (!pid || pid <= 0) {
        return false;
    }
    try {
        kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * When the machine booted, in epoch milliseconds.
 *
 * A reboot resets the PID space, so a PID recorded before the current boot says
 * nothing about the process that holds that number now — `isPidAlive` on it is a
 * plausible-looking false positive. Records carry a `savedAt` stamped while the
 * session was running, so `savedAt < bootTime` proves the record predates the
 * boot and the process it names is gone.
 */
export function machineBootTimeMs(uptimeSeconds: number, nowMs: number): number {
    return nowMs - uptimeSeconds * 1000;
}

/**
 * A session record as it survives a daemon restart, on disk.
 *
 * Shaped to accept `PersistedSession` as-is. An adapter here would type-check
 * against a mistyped field and quietly resolve every PID to `undefined` — a
 * guard that always says "no owner" is indistinguishable from one that works.
 */
export interface PersistedOwnerRecord {
    /** The metadata the session reported for itself, including its PID. */
    metadata?: { hostPid?: number };
    /** When that report was written — necessarily while the process was alive. */
    savedAt: number;
}

export interface ResolveLiveOwnerInput {
    /**
     * Every PID this daemon currently tracks for the session.
     *
     * Plural on purpose. Tracking is keyed by PID, and an entry for a process
     * that has died is only cleared when its exit event or the next heartbeat
     * sweep gets to it — so a session can legitimately have a stale entry
     * alongside a live one, and asking only the first would report the dead one
     * and wave a duplicate through. Entries here are always created during the
     * current daemon's life, hence during the current boot, so they need no boot
     * gate.
     */
    trackedPids: number[];
    /**
     * The on-disk record for the session. Needed because a session outlives the
     * daemon that spawned it (children are detached), so after a daemon restart
     * the only pointer to a still-running process is this record.
     */
    persisted?: PersistedOwnerRecord;
    /** Epoch ms of the current boot — see {@link machineBootTimeMs}. */
    bootTimeMs: number;
    /** Injected for tests. */
    isAlive?: (pid: number | undefined) => boolean;
}

/**
 * The PID of the process that still owns this session, or `undefined` if no
 * process does.
 */
export function resolveLiveOwnerPid(input: ResolveLiveOwnerInput): number | undefined {
    const isAlive = input.isAlive ?? ((pid: number | undefined) => isPidAlive(pid));

    for (const pid of input.trackedPids) {
        if (pid > 0 && isAlive(pid)) {
            return pid;
        }
    }

    const persisted = input.persisted;
    const hostPid = persisted?.metadata?.hostPid;
    if (!persisted || !hostPid) {
        return undefined;
    }
    // Pre-boot record: the PID it names belongs to whatever reused the number.
    if (persisted.savedAt < input.bootTimeMs) {
        return undefined;
    }
    return isAlive(hostPid) ? hostPid : undefined;
}

/**
 * What the server knows about a session's runtime.
 *
 * `ok: false` is deliberately not collapsed into `active: false`: "the server
 * says nobody is attached" and "we could not ask the server" have to drive
 * different decisions, and merging them is what turns a failed probe into a
 * confident answer.
 */
export type SessionPresence =
    | { ok: true; active: boolean }
    | { ok: false; reason: 'unreachable' | 'unknown-session' };

export type ResumeConflict =
    /** Nothing owns the session — spawn normally. */
    | 'none'
    /** A healthy process owns it; the caller's view is stale. */
    | 'already-running'
    /** A process owns it but has stopped serving; replace it. */
    | 'wedged';

/**
 * Decide what a resume request should do about the process that already owns the
 * session.
 *
 * Only two states can produce a resume request for a session whose process is
 * still up:
 *
 *   - the process is up and the server still sees it, so the CALLER is stale —
 *     another device, or a client that has not yet received the reconnect. The
 *     running session is the right answer; a rival process would corrupt it.
 *   - the process is up but the server has not seen it, so it is holding a dead
 *     socket. That is precisely the state the user is trying to escape, and
 *     refusing would strand them.
 *
 * The server's `active` flag is safe to read this way because of how it is
 * written: a running session heartbeats every 2s (`Session` in
 * `claude/session.ts`), `active` only goes false on an explicit shutdown signal
 * (`session-end`, or the deactivate route the CLI calls on SIGTERM) or after 10
 * minutes of silence (`presence/timeout.ts`). A dropped connection does not flip
 * it — the heartbeat is `volatile`, so a blip merely stops refreshing
 * `lastActiveAt`, and the 10-minute sweep is the grace period. `active === false`
 * on a process that is still alive therefore means it announced it was leaving
 * and did not, or it has been silent for 300× its heartbeat interval.
 *
 * When the server cannot be asked, the answer is `already-running`, not
 * `wedged`. The two mistakes are not symmetric: refusing to spawn costs the user
 * a retry, while killing on a guess costs whatever the process was in the middle
 * of doing.
 */
export function classifyResumeConflict(liveOwnerPid: number | undefined, presence: SessionPresence): ResumeConflict {
    if (liveOwnerPid === undefined) {
        return 'none';
    }
    if (presence.ok && !presence.active) {
        return 'wedged';
    }
    return 'already-running';
}
