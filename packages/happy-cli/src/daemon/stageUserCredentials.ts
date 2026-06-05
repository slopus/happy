/**
 * Stage a requesting user's Happy credentials in a per-spawn tmp directory so
 * the child CLI authenticates as that user instead of inheriting the daemon's
 * shared ~/.happy-dev/access.key. The directory layout mirrors the daemon's
 * happyHomeDir so the child's existing readCredentials() works unchanged.
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { join } from 'node:path'
import * as tmp from 'tmp'

export interface StagedUserCredentials {
  homeDir: string
}

const STAGED_DIR_PREFIX = 'happy-session-'

export async function stageUserCredentials(
  happyToken: string,
  happySecret: string,
): Promise<StagedUserCredentials> {
  const userHomeDir = tmp.dirSync({ prefix: STAGED_DIR_PREFIX })
  await fs.mkdir(join(userHomeDir.name, 'logs'), { recursive: true })
  await fs.writeFile(
    join(userHomeDir.name, 'access.key'),
    JSON.stringify({ token: happyToken, secret: happySecret }, null, 2),
    { mode: 0o600 },
  )
  return { homeDir: userHomeDir.name }
}

/**
 * Remove a previously staged user-credentials directory. Refuses paths that
 * are not under the expected parent directory with the expected prefix so a
 * bad caller cannot turn this into an arbitrary-directory wipe. Missing
 * directories are treated as a no-op (idempotent). `expectedParent` defaults
 * to the OS tmp dir; callers can override for tests or when staging somewhere
 * else.
 */
export async function unstageUserCredentials(
  homeDir: string,
  expectedParent: string = tmpdir(),
): Promise<void> {
  const resolved = resolve(homeDir)
  const parent = await fs.realpath(dirname(resolved)).catch(() => resolve(dirname(resolved)))
  const expected = await fs.realpath(expectedParent).catch(() => resolve(expectedParent))
  const name = basename(resolved)
  if (parent !== expected || !name.startsWith(STAGED_DIR_PREFIX)) {
    throw new Error(
      `refusing to unstage ${homeDir}: must be a direct child of ${expected} with prefix ${STAGED_DIR_PREFIX}`,
    )
  }
  await fs.rm(resolved, { recursive: true, force: true })
}

/** Exposed for tests and startup sweep. */
export function isStagedUserCredentialsDir(name: string): boolean {
  return name.startsWith(STAGED_DIR_PREFIX)
}

/**
 * Remove staged directories under the OS tmp dir that are not referenced by
 * any currently-live session. Intended to be called on daemon startup so
 * crash-interrupted spawns do not leak credentials into /tmp indefinitely.
 */
export async function sweepOrphanUserHomeDirs(
  knownLiveDirs: Iterable<string>,
  parentDir: string = tmpdir(),
): Promise<string[]> {
  const keep = new Set<string>()
  for (const d of knownLiveDirs) keep.add(resolve(d))

  let entries: string[]
  try {
    entries = await fs.readdir(parentDir)
  } catch {
    return []
  }

  const removed: string[] = []
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
  return removed
}
