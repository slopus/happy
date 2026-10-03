/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R11 — under strict
 * machine control the remote file handlers keep out of the happy home, which
 * holds the machine key, every session's data key and the account secret
 * backup. Compat leaves it reachable: its company key reseed rewrites
 * credentials there through these handlers.
 *
 * Only the structured file handlers are covered. `bash` runs whatever its
 * caller writes, so this is a narrower surface for the machine-key holder,
 * not a wall against it.
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { configuration } from '@/configuration'

export function isStrictlyGuardedPath(path: string): boolean {
  return configuration.machineControl === 'strict' && isWithinDirectory(path, configuration.happyHomeDir)
}

/**
 * True when `target` is `directory` or lies below it, by name or by identity:
 * a symlink into the directory or to anything inside it, or another spelling
 * of it on a case-insensitive file system, is still the directory. A target
 * that does not exist yet is judged where writing it would land.
 *
 * The answer holds for the file system as it is now; a link swapped between
 * this check and the handler's own open is not covered.
 */
export function isWithinDirectory(target: string, directory: string): boolean {
  const resolvedTarget = resolve(target)
  const resolvedDirectory = resolve(directory)
  if (lexicallyWithin(resolvedDirectory, resolvedTarget)) return true
  const landing = followLinks(resolvedTarget)
  if (lexicallyWithin(followLinks(resolvedDirectory), landing)) return true

  let guarded: { dev: bigint; ino: bigint }
  try {
    const info = statSync(resolvedDirectory, { bigint: true })
    guarded = { dev: info.dev, ino: info.ino }
  } catch {
    return false
  }
  for (let current = landing; ; current = dirname(current)) {
    try {
      const info = statSync(current, { bigint: true })
      if (info.dev === guarded.dev && info.ino === guarded.ino) return true
    } catch {
      // Not there (yet); the parent decides.
    }
    if (dirname(current) === current) return false
  }
}

/** Bounds link chains; a longer one (or a loop) is left unresolved, which open(2) refuses too. */
const MAX_LINK_HOPS = 40

/**
 * Where an absolute path leads once every link on the way is followed, the
 * final one included even when its target does not exist yet: writing through
 * a dangling link creates the file at the link's target.
 */
function followLinks(path: string, hops = 0): string {
  try {
    return realpathSync.native(path)
  } catch {
    // Missing, dangling or looping: walk it by hand.
  }
  if (hops >= MAX_LINK_HOPS) return path
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return followLinks(resolve(dirname(path), readlinkSync(path)), hops + 1)
    }
  } catch {
    // Not there (yet); its parent decides where it would land.
  }
  const parent = dirname(path)
  return parent === path ? path : join(followLinks(parent, hops), basename(path))
}

function lexicallyWithin(directory: string, target: string): boolean {
  const suffix = relative(directory, target)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}
