import { join } from 'node:path';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { configuration } from '@/configuration';

export interface LoadSessionMetadataCacheOptions {
  cacheFileName: string;
  cacheVersion: number;
  scopeKey: string;
  scopeValue: string;
}

export interface SaveSessionMetadataCacheOptions<T> extends LoadSessionMetadataCacheOptions {
  entries: Record<string, T>;
}

const CACHE_LOCK_TIMEOUT_MS = 2_000;
const CACHE_LOCK_RETRY_INTERVAL_MS = 40;
const CACHE_LOCK_STALE_MS = 15_000;

function getSessionMetadataCachePath(cacheFileName: string): string {
  return join(configuration.happyHomeDir, cacheFileName);
}

function getCacheLockPath(cachePath: string): string {
  return `${cachePath}.lock`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryCleanupStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStats = await stat(lockPath);
    if (Date.now() - lockStats.mtimeMs <= CACHE_LOCK_STALE_MS) {
      return;
    }
  } catch {
    return;
  }

  try {
    await unlink(lockPath);
  } catch {
    // best-effort stale lock cleanup
  }
}

async function acquireCacheLock(lockPath: string): Promise<FileHandle | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < CACHE_LOCK_TIMEOUT_MS) {
    try {
      return await open(lockPath, 'wx');
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        return null;
      }
      await tryCleanupStaleLock(lockPath);
      await sleep(CACHE_LOCK_RETRY_INTERVAL_MS);
    }
  }

  return null;
}

async function releaseCacheLock(lockFileHandle: FileHandle, lockPath: string): Promise<void> {
  try {
    await lockFileHandle.close();
  } catch {
    // ignore
  }

  try {
    await unlink(lockPath);
  } catch {
    // ignore
  }
}

async function writeCacheFileAtomically(cachePath: string, payload: Record<string, unknown>): Promise<void> {
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(payload), 'utf8');
    await rename(tempPath, cachePath);
  } finally {
    try {
      await unlink(tempPath);
    } catch {
      // ignore temp cleanup failures
    }
  }
}

export function normalizeSessionTitle(value: string, maxLength: number = 80): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxLength - 3)) + '...';
}

export async function loadSessionMetadataCache<T>(
  options: LoadSessionMetadataCacheOptions,
): Promise<Record<string, T>> {
  const cachePath = getSessionMetadataCachePath(options.cacheFileName);

  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    if (parsed.version !== options.cacheVersion) return {};
    if (parsed.scopeKey !== options.scopeKey) return {};
    if (parsed.scopeValue !== options.scopeValue) return {};
    if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return {};
    return parsed.entries as Record<string, T>;
  } catch {
    return {};
  }
}

export async function saveSessionMetadataCache<T>(
  options: SaveSessionMetadataCacheOptions<T>,
): Promise<void> {
  const cachePath = getSessionMetadataCachePath(options.cacheFileName);
  const lockPath = getCacheLockPath(cachePath);
  const lockFileHandle = await acquireCacheLock(lockPath);
  if (!lockFileHandle) {
    return;
  }

  const payload: Record<string, unknown> = {
    version: options.cacheVersion,
    scopeKey: options.scopeKey,
    scopeValue: options.scopeValue,
    entries: options.entries,
  };

  try {
    await writeCacheFileAtomically(cachePath, payload);
  } catch {
    // best-effort cache write
  } finally {
    await releaseCacheLock(lockFileHandle, lockPath);
  }
}
