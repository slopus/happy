import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants, watch } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, link, readlink } from 'node:fs/promises';
import type { ArtifactErrorCode } from '@slopus/happy-wire';

export class ArtifactError extends Error {
  constructor(readonly code: ArtifactErrorCode, message: string, readonly operationId?: string, readonly actualRevision?: string) { super(message); }
}
export const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const inside = (root: string, path: string) => { const p = relative(root, path); return !isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep); };
export const intersects = (a: string, b: string) => inside(a, b) || inside(b, a);
export function normalized(path: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Invalid managed path');
  return path;
}
/** Resolve missing targets through their existing ancestors, including dangling file aliases. */
export async function canonicalWriteTarget(path: string, depth = 0): Promise<string> {
  if (depth > 128) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Write target cannot be resolved safely');
  try { return await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    if ((await lstat(path)).isSymbolicLink()) return canonicalWriteTarget(resolve(dirname(path), await readlink(path)), depth + 1);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = dirname(path);
  if (parent === path) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Write target has no accessible ancestor');
  return join(await canonicalWriteTarget(parent, depth + 1), relative(parent, path));
}

/** Reject symlink components and hardlinks: managed paths must have a single owned identity. */
export async function ownedPath(root: string, path: string): Promise<string> {
  normalized(path);
  if (await realpath(root) !== root) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Workspace root changed');
  let target = root;
  for (const component of path.split('/')) {
    target = join(target, component);
    try {
      const info = await lstat(target);
      if (await realpath(target) !== target || info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink > 1))) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Managed path has an unsupported filesystem identity');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
export async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new ArtifactError('LIMIT_EXCEEDED', 'File exceeds the supported limit');
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== info.size) throw new ArtifactError('READ_UNSTABLE', 'File changed during read');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
export async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function atomicFile(path: string, bytes: string | Buffer, mode = 0o600, beforeRename?: () => Promise<void>) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.paws-artifact-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    try { await handle.writeFile(bytes); await handle.chmod(mode & 0o777); await handle.sync(); } finally { await handle.close(); }
    await beforeRename?.(); await rename(temporary, path); await syncDirectory(dirname(path));
  } finally { await unlink(temporary).catch(() => {}); }
}
/** Install a complete private receipt once; readers never observe a partial JSON file. */
export async function atomicCreateFile(path: string, bytes: string) {
  const candidate = join(dirname(path), `.receipt-${randomUUID()}`);
  await atomicFile(candidate, bytes);
  try {
    try { await link(candidate, path); await syncDirectory(dirname(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await unlink(candidate).catch(() => {}); }
}

export type ProcessOwner = { pid: number; birth: string };
export async function processOwner(pid = process.pid): Promise<ProcessOwner> {
  // PID start identity prevents reuse being treated as ownership; errors fail closed.
  const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', String(pid)]);
  const birth = stdout.trim();
  if (!birth) throw new ArtifactError('UNAVAILABLE', 'Cannot verify process identity');
  return { pid, birth };
}
export async function ownerAlive(owner: ProcessOwner): Promise<boolean> {
  try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw new ArtifactError('UNAVAILABLE', 'Cannot verify writer process'); }
  return (await processOwner(owner.pid)).birth === owner.birth;
}
export type MachineLockOptions = { waitTimeoutMs?: number };
/** Atomic owner link; optional waiting is driven only by filesystem events, never polling. */
export async function withMachineLock<T>(storage: string, body: () => Promise<T>, options: MachineLockOptions = {}): Promise<T> {
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const candidate = join(storage, `.owner-${randomUUID()}`), lock = join(storage, 'machine.lock');
  await atomicFile(candidate, JSON.stringify(await processOwner()));
  let acquired = false, generation = 0, timedOut = false;
  let wake: (() => void) | undefined, watchError: Error | undefined;
  let watcher: ReturnType<typeof watch> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const busy = () => new ArtifactError('WRITER_ACTIVE', 'Another managed operation is active');
  const acquire = async () => {
    try { await link(candidate, lock); acquired = true; return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    let previous: ProcessOwner;
    try { previous = JSON.parse(await readFile(lock, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // The observed owner released the lock during the read; one atomic CAS is safe.
      try { await link(candidate, lock); acquired = true; return; }
      catch (next) { if ((next as NodeJS.ErrnoException).code === 'EEXIST') throw busy(); throw next; }
    }
    if (await ownerAlive(previous)) throw busy();
    const reaper = join(storage, 'machine.reclaim');
    try { await link(candidate, reaper); } catch { throw new ArtifactError('UNAVAILABLE', 'Lock recovery requires verification'); }
    try {
      if (JSON.stringify(JSON.parse(await readFile(lock, 'utf8'))) !== JSON.stringify(previous)) throw busy();
      await unlink(lock); await link(candidate, lock); acquired = true;
    } finally { await unlink(reaper); }
  };
  try {
    if (options.waitTimeoutMs !== undefined) {
      // Some filesystems report the owner hardlink name instead of machine.lock.
      // Directory changes are only wakeups; the atomic acquisition remains authoritative.
      watcher = watch(storage, { persistent: false }, () => { generation++; wake?.(); });
      watcher.on('error', error => { watchError = error; wake?.(); });
      deadline = setTimeout(() => { timedOut = true; wake?.(); }, options.waitTimeoutMs);
    }
    while (!acquired) {
      if (watchError) throw new ArtifactError('UNAVAILABLE', 'Lock release events are unavailable');
      if (timedOut) throw busy();
      const observed = generation;
      try { await acquire(); }
      catch (error) {
        if (!watcher || !(error instanceof ArtifactError) || error.code !== 'WRITER_ACTIVE') throw error;
        if (observed === generation && !timedOut) await new Promise<void>(resolve => { wake = resolve; });
      }
    }
    return await body();
  } finally {
    if (deadline) clearTimeout(deadline);
    watcher?.close();
    if (acquired) await unlink(lock);
    await unlink(candidate).catch(() => {});
  }
}
