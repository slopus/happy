import type { DaemonLocallyPersistedState } from '@/persistence'

/**
 * Decide whether the daemon state file has to be rebuilt after stopping the
 * daemon that was running.
 *
 * A stopping daemon runs *its own* shutdown code, and versions at or below
 * 1.1.9 unlink the state file instead of marking it stopped. Its children stay
 * alive, but the record naming them is gone, so the replacement daemon finds
 * nothing to recover and every session it inherited becomes untrackable
 * (2026-07-31 incident). The replacement can't patch the old process — it can
 * only put back the snapshot it read before the stop.
 *
 * Returns the state to write, or null when nothing needs restoring.
 */
export function resolveStatePreservation({
  before,
  after,
}: {
  /** State read immediately before stopping the running daemon. */
  before: DaemonLocallyPersistedState | null
  /** State read back after it exited. */
  after: DaemonLocallyPersistedState | null
}): DaemonLocallyPersistedState | null {
  if (!before?.trackedSessions?.length) return null
  if (after) return null
  return { ...before, state: 'stopped' }
}

export async function prepareDaemonStartup({
  preflightCandidate,
  runningVersionMatches,
  stopRunningDaemon,
  previousDaemonGone = false,
}: {
  preflightCandidate: () => Promise<void>
  runningVersionMatches: () => Promise<boolean>
  stopRunningDaemon: () => Promise<void>
  /** Exact process-incarnation evidence, never inferred merely from a stale state flag. */
  previousDaemonGone?: boolean
}): Promise<'start' | 'already-running'> {
  await preflightCandidate()
  if (previousDaemonGone) return 'start'

  if (await runningVersionMatches()) {
    return 'already-running'
  }

  await stopRunningDaemon()
  return 'start'
}

/**
 * Hand the machine over to a daemon built from the replaced bundle.
 *
 * `spawnReplacement` must resolve `true` only once the replacement process
 * actually exists. Teardown has already released the socket, control server,
 * state file and lock by the time it runs, so a spawn that silently does
 * nothing leaves the machine with no daemon at all and nobody to notice
 * (2026-08-23 incident). Retrying is the only recovery available here — the
 * current daemon cannot un-tear-down itself.
 */
export async function handoffToReplacedBundle({
  preflightReplacement,
  canHandoff,
  teardownCurrentDaemon,
  spawnReplacement,
  spawnAttempts = 3,
  waitBetweenAttempts = (attempt) => new Promise(resolve => setTimeout(resolve, attempt * 500)),
}: {
  preflightReplacement: () => Promise<boolean>
  canHandoff?: () => boolean
  teardownCurrentDaemon: () => Promise<void>
  spawnReplacement: (attempt: number) => Promise<boolean>
  spawnAttempts?: number
  /**
   * Spacing between attempts. The failures worth retrying here are transient
   * resource ones (fork under memory pressure, EAGAIN); retrying those within
   * the same few milliseconds just fails three times instead of once.
   */
  waitBetweenAttempts?: (attempt: number) => Promise<void>
}): Promise<'kept-current' | 'deferred' | 'handed-off' | 'replacement-not-started'> {
  if (!await preflightReplacement()) {
    return 'kept-current'
  }

  if (canHandoff && !canHandoff()) {
    return 'deferred'
  }

  await teardownCurrentDaemon()

  for (let attempt = 1; attempt <= spawnAttempts; attempt++) {
    try {
      if (await spawnReplacement(attempt)) {
        return 'handed-off'
      }
    } catch {
      // Treat a throwing attempt like a failed one — the next attempt is the
      // only thing that can still put a daemon back on this machine.
    }

    if (attempt < spawnAttempts) {
      await waitBetweenAttempts(attempt)
    }
  }

  return 'replacement-not-started'
}
