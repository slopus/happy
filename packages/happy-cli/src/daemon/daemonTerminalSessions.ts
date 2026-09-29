/**
 * Per-daemon registry of active PTY-backed terminal sessions
 * (specs/remote-terminal/ Phase 2 + Phase 5). Holds the mapping between
 * server-issued sessionId and the local PtySession, plus the bookkeeping
 * needed for the audit log (openedAt, bytesIn/Out) and the idle-timeout
 * watchdog (Phase 5).
 *
 * Pure data-structure module — no socket.io / api coupling. apiMachine.ts
 * uses these helpers to plumb socket events into PtySession actions and
 * to record activity for the idle timer.
 */

import { type PtySession, type TerminateOutcome } from './remoteTerminal'
import { createTerminalOutputBuffer, type TerminalOutputBuffer } from './terminalOutputBuffer'

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Shorter graceful window for bulk teardown: the relay path is already dead at
 * that point, so nothing the shell prints can reach anyone and there is no
 * reason to wait out the full per-session grace.
 */
const DISCONNECT_GRACE_MS = 500

export interface DaemonTerminalEntry {
    readonly id: string
    readonly session: PtySession
    readonly userId: string
    readonly machineId: string | null
    readonly openedAt: number
    bytesIn: number
    bytesOut: number
    /** Last in/out activity wallclock ms — drives the idle timer reset. */
    lastActivityAt: number
    /**
     * Bounded replay buffer for this terminal's output
     * (specs/desktop-terminal-reliability/ Phase 3). Lives here rather than in
     * the relay because happy-server is multi-replica: a buffer kept there
     * would sit on one replica and a client reconnecting onto a peer would
     * find nothing.
     */
    readonly output: TerminalOutputBuffer
}

interface InternalEntry extends DaemonTerminalEntry {
    _idleTimeoutMs: number
    _idleTimer: ReturnType<typeof setTimeout> | null
}

export interface AddSessionOptions {
    userId: string
    machineId?: string | null
    /** ms with no in/out activity before teardown. Defaults to 15 min. Pass 0 to disable. */
    idleTimeoutMs?: number
    /** Replay buffer ceiling in characters. Defaults to DEFAULT_TERMINAL_BUFFER_CHARS. */
    outputBufferChars?: number
    /** Replay buffer ceiling in frames. Defaults to DEFAULT_TERMINAL_BUFFER_FRAMES. */
    outputBufferFrames?: number
}

const sessions = new Map<string, InternalEntry>()

function clearIdleTimer(entry: InternalEntry): void {
    if (entry._idleTimer) {
        clearTimeout(entry._idleTimer)
        entry._idleTimer = null
    }
}

function armIdleTimer(entry: InternalEntry): void {
    clearIdleTimer(entry)
    if (entry._idleTimeoutMs <= 0) return
    entry._idleTimer = setTimeout(() => {
        // Trust pty.onExit to fire and remove the entry from the map; if
        // the teardown races with a manual close, removeDaemonTerminalSession
        // and terminate() are both idempotent.
        void entry.session.terminate()
    }, entry._idleTimeoutMs)
}

export function addDaemonTerminalSession(
    id: string,
    session: PtySession,
    opts: AddSessionOptions,
): DaemonTerminalEntry {
    const now = Date.now()
    const entry: InternalEntry = {
        id,
        session,
        userId: opts.userId,
        machineId: opts.machineId ?? null,
        openedAt: now,
        bytesIn: 0,
        bytesOut: 0,
        lastActivityAt: now,
        output: createTerminalOutputBuffer(opts.outputBufferChars, opts.outputBufferFrames),
        _idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        _idleTimer: null,
    }
    sessions.set(id, entry)
    armIdleTimer(entry)
    return entry
}

export function getDaemonTerminalSession(id: string | undefined | null): DaemonTerminalEntry | null {
    if (!id) return null
    return sessions.get(id) ?? null
}

export function getDaemonTerminalSessionCount(): number {
    return sessions.size
}

export function removeDaemonTerminalSession(id: string): boolean {
    const entry = sessions.get(id)
    if (!entry) return false
    clearIdleTimer(entry)
    return sessions.delete(id)
}

/**
 * Tear down every registered session. Returns how many were signalled.
 *
 * Deliberately takes no signal argument: callers used to pass 'SIGTERM', which
 * interactive shells ignore outright, so this "kill all" quietly killed nothing
 * and leaked a shell per session (specs/remote-terminal-close-leak/).
 * `terminate()` owns the SIGHUP → SIGKILL escalation and holds its own
 * reference to the child, so dropping the map entry here cannot cancel it.
 *
 * Outcomes are intentionally not awaited or logged here: this module stays
 * logger-free (see the file header), and every successful teardown is already
 * audited by the `pty.onExit` handler in apiMachine.ts. The user-initiated
 * close path logs abnormal outcomes explicitly.
 */
export function killAllDaemonTerminalSessions(): number {
    let killed = 0
    for (const [id, entry] of sessions) {
        clearIdleTimer(entry)
        void entry.session.terminate({ graceMs: DISCONNECT_GRACE_MS })
        killed++
        sessions.delete(id)
    }
    return killed
}

/**
 * Like `killAllDaemonTerminalSessions`, but waits for every teardown and reports each outcome.
 * An app-close drain (Desktop specs/windows-build-support W0-5h) may only finish once every
 * terminal it owned is proven gone; `escaped` means it was not.
 */
export function terminateAllDaemonTerminalSessions(): Promise<TerminateOutcome[]> {
    const pending: Promise<TerminateOutcome>[] = []
    for (const [id, entry] of sessions) {
        clearIdleTimer(entry)
        pending.push(entry.session.terminate().catch((): TerminateOutcome => 'escaped'))
        sessions.delete(id)
    }
    return Promise.all(pending)
}

/**
 * Mark the session as still being watched, without counting any bytes.
 *
 * For signals that prove a client is there but carry no terminal traffic — a
 * `terminal-resume` after a reconnect. The byte counters feed the audit log, so
 * inflating them here would misreport what actually crossed the wire; what this
 * needs to move is the idle clock. Without it a terminal recovered at minute 14
 * is still torn down at minute 15.
 */
export function recordTerminalActivity(id: string): void {
    const entry = sessions.get(id)
    if (!entry) return
    entry.lastActivityAt = Date.now()
    armIdleTimer(entry)
}

/**
 * Record bytes flowing client → PTY (stdin). Increments the in counter
 * and resets the idle timer. No-op if the session is no longer registered.
 */
export function recordBytesIn(id: string, n: number): void {
    const entry = sessions.get(id)
    if (!entry || n <= 0) return
    entry.bytesIn += n
    entry.lastActivityAt = Date.now()
    armIdleTimer(entry)
}

/**
 * Record bytes flowing PTY → client (stdout/stderr). Increments the out
 * counter and resets the idle timer. No-op if the session is no longer
 * registered.
 */
export function recordBytesOut(id: string, n: number): void {
    const entry = sessions.get(id)
    if (!entry || n <= 0) return
    entry.bytesOut += n
    entry.lastActivityAt = Date.now()
    armIdleTimer(entry)
}

export function _resetDaemonTerminalSessionsForTest(): void {
    for (const entry of sessions.values()) {
        clearIdleTimer(entry)
    }
    sessions.clear()
}
