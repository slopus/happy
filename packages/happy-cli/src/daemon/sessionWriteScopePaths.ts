import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export type WriteRoot = { requestedPath: string; root: string; identity: string; floor: string[] };
export function containsPath(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
async function existingParent(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return existingParent(dirname(path));
  }
}

/** Preserve absent suffixes after resolving existing ancestors; dangling aliases are unsafe. */
async function protectedPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    const existing = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    });
    if (existing) throw new Error('UNRESOLVED_PROTECTED_PATH');
    return join(await protectedPath(dirname(path)), basename(path));
  }
}

/** Approve the displayed, existing directory; never silently create parents. */
export async function canonicalizeSessionWriteRoot(requestedPath: string, input: {
  home: string; protectedRoots: readonly string[];
}): Promise<WriteRoot> {
  if (typeof requestedPath !== 'string' || requestedPath.length > 2048 || !isAbsolute(requestedPath)
    || /[\x00-\x1f\x7f*?\[\]{}]/.test(requestedPath)
    || requestedPath.split(/[\\/]/).includes('..')) throw new Error('INVALID_WRITE_PATH');
  const home = await realpath(input.home);
  const root = await existingParent(resolve(requestedPath));
  const info = await stat(root);
  if (!info.isDirectory() || !containsPath(home, root) || root === home
    || dirname(root) === home || root === parse(root).root) throw new Error('WRITE_ROOT_TOO_BROAD');
  const protectedRoots = [...input.protectedRoots,
    ...['.ssh', '.aws', '.azure', '.config', '.codex', '.claude', '.agents', '.gnupg', '.kube', 'Library',
      '.local/share/keyrings'].map(path => join(home, path))];
  const floor: string[] = [];
  for (const path of protectedRoots) {
    const canonical = await protectedPath(resolve(path));
    if (containsPath(root, canonical) || containsPath(canonical, root)) throw new Error('PROTECTED_WRITE_ROOT');
    if (path === join(home, '.codex')) floor.push(join(canonical, 'auth.json'), join(canonical, 'config.toml'));
    else if (path === join(home, '.claude')) floor.push(join(canonical, '.credentials.json'), join(canonical, 'settings.json'));
    else floor.push(canonical);
  }
  return { requestedPath, root, identity: `${info.dev}:${info.ino}`, floor: [...new Set(floor)] };
}
