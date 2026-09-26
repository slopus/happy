/**
 * Stage a requesting user's Happy credentials in a per-spawn private directory so
 * the child CLI authenticates as that user instead of inheriting the daemon's
 * shared ~/.happy-dev/access.key. The directory layout mirrors the daemon's
 * happyHomeDir so the child's existing readCredentials() works unchanged.
 */

import { promises as fs } from 'node:fs'
import { stagingParent } from './stagedCredentialRoot'
import { basename, dirname, resolve } from 'node:path'
import { join } from 'node:path'
import * as tmp from 'tmp'
import { tmpdir } from 'node:os'

export interface StagedUserCredentials {
  homeDir: string
}

const STAGED_DIR_PREFIX = 'happy-session-'

/**
 * Parents a staged directory may live under: the current one, plus the OS tmp dir, where every
 * directory staged before the machine became mandatory still sits. Both are fixed locations, never
 * caller input, so accepting either keeps unstage/sweep from becoming an arbitrary-directory wipe.
 */
export function credentialStagingParents(current: string = stagingParent()): string[] {
  return [...new Set([current, tmpdir()])]
}

export async function stageUserCredentials(
  happyToken: string,
  happySecret: string,
  /**
   * The live daemon's own `daemon.state.json`. Copied into the staged dir —
   * see below for why this is not optional in practice.
   */
  daemonStateFile?: string,
): Promise<StagedUserCredentials> {
  const userHomeDir = tmp.dirSync({ prefix: STAGED_DIR_PREFIX, tmpdir: stagingParent(), mode: 0o700 })
  await fs.mkdir(join(userHomeDir.name, 'logs'), { recursive: true })
  await fs.writeFile(
    join(userHomeDir.name, 'access.key'),
    JSON.stringify({ token: happyToken, secret: happySecret }, null, 2),
    { mode: 0o600 },
  )

  // Staging works by pointing the child at this dir via HAPPY_HOME_DIR, but
  // that env var moves *every* happy path at once (configuration.ts), not just
  // access.key — including `daemon.state.json`. The child reports its startup
  // webhook through `daemonPost`, which reads that file to find the daemon's
  // HTTP port; with the file absent it fails with "No daemon running, no state
  // file found" and the spawn dies as "Session webhook timeout for PID ...".
  //
  // So copy the daemon's current state in. A snapshot is correct here: the
  // child only needs it to reach the daemon that spawned it, and `daemonPost`
  // re-reads the file per call, so a daemon that restarts on a new port is
  // handled by the caller re-staging rather than by this copy going stale.
  if (daemonStateFile) {
    try {
      const state = await fs.readFile(daemonStateFile, 'utf-8')
      await fs.writeFile(join(userHomeDir.name, 'daemon.state.json'), state, { mode: 0o600 })
    } catch {
      // Best-effort: a missing/unreadable daemon state file means the child
      // falls back to the same "no state file" path it had before this copy
      // existed. Failing the whole spawn here would be worse.
    }
  }

  return { homeDir: userHomeDir.name }
}

/**
 * Remove a previously staged user-credentials directory. Refuses paths that
 * are not under the expected parent directory with the expected prefix so a
 * bad caller cannot turn this into an arbitrary-directory wipe. Missing
 * directories are treated as a no-op (idempotent). `expectedParents` defaults
 * to credentialStagingParents() (the current parent and the OS tmp dir).
 * Callers can override it for isolated tests.
 */
export async function unstageUserCredentials(
  homeDir: string,
  expectedParents: string | string[] = credentialStagingParents(),
): Promise<void> {
  const resolved = resolve(homeDir)
  const parent = await fs.realpath(dirname(resolved)).catch(() => resolve(dirname(resolved)))
  const expected = await Promise.all((Array.isArray(expectedParents) ? expectedParents : [expectedParents])
    .map((candidate) => fs.realpath(candidate).catch(() => resolve(candidate))))
  const name = basename(resolved)
  if (!expected.includes(parent) || !name.startsWith(STAGED_DIR_PREFIX)) {
    throw new Error(
      `refusing to unstage ${homeDir}: must be a direct child of ${expected.join(' or ')} with prefix ${STAGED_DIR_PREFIX}`,
    )
  }
  await fs.rm(resolved, { recursive: true, force: true })
}

/** Exposed for tests and startup sweep. */
export function isStagedUserCredentialsDir(name: string): boolean {
  return name.startsWith(STAGED_DIR_PREFIX)
}

/**
 * Remove staged directories under every trusted staging parent that are not referenced by
 * any currently-live session. Intended to be called on daemon startup so
 * crash-interrupted spawns do not leak credentials into /tmp indefinitely.
 */
export async function sweepOrphanUserHomeDirs(
  knownLiveDirs: Iterable<string>,
  parentDirs: string | string[] = credentialStagingParents(),
): Promise<string[]> {
  const keep = new Set<string>()
  for (const d of knownLiveDirs) keep.add(resolve(d))

  const removed: string[] = []
  for (const parentDir of Array.isArray(parentDirs) ? parentDirs : [parentDirs]) {
    let entries: string[]
    try {
      entries = await fs.readdir(parentDir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!isStagedUserCredentialsDir(name)) continue
      const full = resolve(parentDir, name)
      if (keep.has(full)) continue
      try {
        await unstageUserCredentials(full, parentDir)
        removed.push(full)
      } catch {
        // Best-effort: ignore errors from a single dir so one permission issue
        // cannot block the entire sweep.
      }
    }
  }
  return removed
}
