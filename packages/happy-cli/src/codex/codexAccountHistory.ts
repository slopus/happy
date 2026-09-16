import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AsyncLock } from '@/utils/lock';
import { collectCodexUsageSnapshot, type CodexUsageSnapshot } from './codexUsage';

const copyLock = new AsyncLock();
export class CodexSourceHistoryUnavailableError extends Error {
  constructor() { super('Codex source history unavailable. This session has no retained Paws account history on this machine.'); }
}
export class CodexSourceAccountMismatchError extends Error {
  constructor() { super('This Codex session belongs to a different account. Rebind this machine to the original Codex account before resuming it.'); }
}
const profilePath = (root: string, profileId: string) => join(root, createHash('sha256').update(profileId).digest('hex'));
const profileIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error('Invalid Codex history directory');
  await chmod(path, 0o700);
}
async function copyRollouts(source: string, destination: string, threadId?: string): Promise<number> {
  const sourceStat = await lstat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) return 0;
  let found = 0;
  await privateDirectory(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name); const to = join(destination, entry.name);
    if (entry.isDirectory()) { found += await copyRollouts(from, to, threadId); continue; }
    if (!entry.isFile() || !/^rollout-[^/\\]+\.jsonl$/.test(entry.name)) continue;
    if (threadId && !entry.name.endsWith(`-${threadId}.jsonl`)) continue;
    const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const temp = join(destination, `.copy-${randomUUID()}`);
    try {
      const info = await input.stat(); if (!info.isFile()) continue;
      found++;
      const existing = await lstat(to).catch(() => null);
      if (existing && (!existing.isFile() || existing.mtimeMs >= info.mtimeMs)) continue;
      const output = await open(temp, 'wx', 0o600);
      try { await pipeline(input.createReadStream(), output.createWriteStream()); }
      finally { await output.close(); }
      await utimes(temp, info.atime, info.mtime);
      await rename(temp, to);
    } finally { await input.close(); await rm(temp, { force: true }); }
  }
  return found;
}
async function copyNativeHistory(source: string, destination: string, threadId?: string): Promise<number> {
  if (!(await lstat(source).catch(() => null))?.isDirectory()) return 0;
  // Native thread lookup can rebuild indexes from rollouts. Never copy SQLite,
  // auth, config, logs, credentials, arbitrary JSON, or symlinks.
  let found = 0;
  for (const entry of ['sessions', 'archived_sessions']) found += await copyRollouts(join(source, entry), join(destination, entry), threadId);
  return found;
}
export async function retainCodexAccountHistory(root: string, profileId: string, home: string): Promise<void> {
  await copyLock.inLock(async () => {
    await privateDirectory(root); const target = profilePath(root, profileId); await privateDirectory(target);
    await copyNativeHistory(home, target);
  });
}
export async function restoreCodexAccountHistory(root: string, profileId: string, home: string): Promise<void> {
  await copyLock.inLock(async () => { await copyNativeHistory(profilePath(root, profileId), home); });
}

const auditPath = (root: string, sessionId: string) => join(root, 'session-audit', createHash('sha256').update(sessionId).digest('hex') + '.json');
async function readCodexSourceAccountAudit(root: string, sessionId: string): Promise<{ profileId: string; home?: string } | undefined> {
  if (!sessionId) return undefined;
  const path = auditPath(root, sessionId);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw new CodexSourceHistoryUnavailableError();
  });
  if (!info) return undefined;
  try {
    if (!info.isFile()) throw new Error();
    const audit = JSON.parse(await readFile(path, 'utf8')) as { profileId?: unknown; home?: unknown };
    if (typeof audit.profileId !== 'string' || !audit.profileId) throw new Error();
    return { profileId: audit.profileId, home: typeof audit.home === 'string' ? audit.home : undefined };
  } catch {
    throw new CodexSourceHistoryUnavailableError();
  }
}

export async function getCodexSourceAccountProfileId(root: string, sessionId: string): Promise<string | undefined> {
  return (await readCodexSourceAccountAudit(root, sessionId))?.profileId;
}

export async function rememberCodexAccountSession(root: string, sessionId: string, profileId: string, home?: string): Promise<void> {
  await copyLock.inLock(async () => {
    await privateDirectory(root); await privateDirectory(join(root, 'session-audit'));
    const target = auditPath(root, sessionId); const temp = target + '.' + randomUUID();
    try { await writeFile(temp, JSON.stringify({ profileId, home }), { mode: 0o600, flag: 'wx' }); await rename(temp, target); }
    finally { await rm(temp, { force: true }); }
  });
}

/**
 * Build account-attributed usage only from Paws' explicit session audit.
 * Local Codex history without this bridge remains intentionally unattributed.
 */
export async function collectRetainedCodexAccountUsage(
  root: string,
  options?: { maxDays?: number },
): Promise<Array<{ profileId: string; usage: CodexUsageSnapshot }>> {
  const auditDirectory = join(root, 'session-audit');
  const profileIds = new Set<string>();
  const entries = await readdir(auditDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const audit = JSON.parse(await readFile(join(auditDirectory, entry.name), 'utf8')) as { profileId?: unknown };
      if (typeof audit.profileId === 'string' && profileIdPattern.test(audit.profileId)) profileIds.add(audit.profileId);
    } catch { /* Ignore malformed or concurrently replaced audit files. */ }
  }
  return Promise.all([...profileIds].sort().map(async (profileId) => ({
    profileId,
    usage: await collectCodexUsageSnapshot({ codexHome: profilePath(root, profileId), maxDays: options?.maxDays }),
  })));
}

/** An explicit owned Paws session is the only bridge across profile caches. */
export async function copyCodexSourceThread(root: string, sourceSessionId: string, threadId: string, target: string, expectedProfileId?: string): Promise<string> {
  if (!sourceSessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) throw new CodexSourceHistoryUnavailableError();
  return copyLock.inLock(async () => {
    try {
      const audit = await readCodexSourceAccountAudit(root, sourceSessionId);
      if (!audit) throw new Error();
      if (expectedProfileId && audit.profileId !== expectedProfileId) throw new CodexSourceAccountMismatchError();
      let found = 0;
      if (typeof audit.home === 'string' && basename(audit.home).startsWith('happy-codex-home-')) {
        const marker = join(audit.home, '.paws-account-launch.json');
        if ((await lstat(marker).catch(() => null))?.isFile()) {
          const ownership = JSON.parse(await readFile(marker, 'utf8'));
          if (ownership.profileId === audit.profileId) found += await copyNativeHistory(audit.home, target, threadId);
        }
      }
      found += await copyNativeHistory(profilePath(root, audit.profileId), target, threadId);
      if (!found) throw new Error();
      return audit.profileId;
    } catch (error) {
      if (error instanceof CodexSourceAccountMismatchError) throw error;
      throw new CodexSourceHistoryUnavailableError();
    }
  });
}
