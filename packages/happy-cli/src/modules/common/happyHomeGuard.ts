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
import { statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { configuration } from '@/configuration'

export function isStrictlyGuardedPath(path: string): boolean {
  return configuration.machineControl === 'strict' && isWithinDirectory(path, configuration.happyHomeDir)
}

/**
 * True when `target` is `directory` or lies below it, by name or by identity:
 * a symlink into the directory, or another spelling of it on a
 * case-insensitive file system, is still the directory. A target that does not
 * exist yet is judged by its nearest existing ancestor.
 */
export function isWithinDirectory(target: string, directory: string): boolean {
  const resolvedTarget = resolve(target)
  const resolvedDirectory = resolve(directory)
  if (lexicallyWithin(resolvedDirectory, resolvedTarget)) return true

  let guarded: { dev: bigint; ino: bigint }
  try {
    const info = statSync(resolvedDirectory, { bigint: true })
    guarded = { dev: info.dev, ino: info.ino }
  } catch {
    return false
  }
  for (let current = resolvedTarget; ; current = dirname(current)) {
    try {
      const info = statSync(current, { bigint: true })
      if (info.dev === guarded.dev && info.ino === guarded.ino) return true
    } catch {
      // Not there (yet); the parent decides.
    }
    if (dirname(current) === current) return false
  }
}

function lexicallyWithin(directory: string, target: string): boolean {
  const suffix = relative(directory, target)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}
