import { join } from 'node:path';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { configuration } from '@/configuration';
import type { SessionCacheRuntimeStats } from './SessionCache';

export interface LoadSessionMetadataCacheOptions {
  cacheFileName: string;
  cacheVersion: number;
  scopeKey: string;
  scopeValue: string;
}

export interface SaveSessionMetadataCacheOptions<T> extends LoadSessionMetadataCacheOptions {
  entries: Record<string, T>;
  lastRun?: SessionMetadataCacheLastRun;
  sessionCache?: SessionCacheRuntimeStats;
}

export interface UpdateSessionMetadataCacheDiagnosticsOptions extends LoadSessionMetadataCacheOptions {
  lastRun?: SessionMetadataCacheLastRun;
  sessionCache?: SessionCacheRuntimeStats;
}

export interface SessionMetadataCacheLastRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  filesProcessed: number;
  filesReparsed: number;
  cacheHitCount: number;
  cacheMissCount: number;
  staleEntryCount: number;
  resultCount: number;
  cacheEntryCount: number;
  extra?: Record<string, number | string | boolean | null>;
}

interface SessionMetadataCacheFile<T> {
  version: number;
  scopeKey: string;
  scopeValue: string;
  entries: Record<string, T>;
  lastRun?: SessionMetadataCacheLastRun;
  sessionCache?: SessionCacheRuntimeStats;
}

const CACHE_LOCK_TIMEOUT_MS = 2_000;
const CACHE_LOCK_RETRY_INTERVAL_MS = 40;
const CACHE_LOCK_STALE_MS = 15_000;
const SESSION_CACHE_DECISIONS = new Set<NonNullable<SessionCacheRuntimeStats['lastDecision']>>([
  'cold-load',
  'fresh-hit',
  'stale-hit',
  'wait-for-refresh',
  'wait-for-existing-refresh',
]);
const SESSION_CACHE_REFRESH_MODES = new Set<NonNullable<SessionCacheRuntimeStats['lastRefreshMode']>>([
  'cold-start',
  'foreground',
  'background',
]);

function getSessionMetadataCachePath(cacheFileName: string): string {
  return join(configuration.happyHomeDir, cacheFileName);
}

function getCacheLockPath(cachePath: string): string {
  return `${cachePath}.lock`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseExtraDiagnostics(value: unknown): Record<string, number | string | boolean | null> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const parsed: Record<string, number | string | boolean | null> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue === null || typeof entryValue === 'string' || typeof entryValue === 'boolean') {
      parsed[key] = entryValue;
      continue;
    }
    if (typeof entryValue === 'number' && Number.isFinite(entryValue)) {
      parsed[key] = entryValue;
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseLastRun(value: unknown): SessionMetadataCacheLastRun | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const startedAt = readString(value.startedAt);
  const finishedAt = readString(value.finishedAt);
  const durationMs = readFiniteNumber(value.durationMs);
  const filesProcessed = readFiniteNumber(value.filesProcessed);
  const filesReparsed = readFiniteNumber(value.filesReparsed);
  const cacheHitCount = readFiniteNumber(value.cacheHitCount);
  const cacheMissCount = readFiniteNumber(value.cacheMissCount);
  const staleEntryCount = readFiniteNumber(value.staleEntryCount);
  const resultCount = readFiniteNumber(value.resultCount);
  const cacheEntryCount = readFiniteNumber(value.cacheEntryCount);

  if (
    startedAt === undefined ||
    finishedAt === undefined ||
    durationMs === undefined ||
    filesProcessed === undefined ||
    filesReparsed === undefined ||
    cacheHitCount === undefined ||
    cacheMissCount === undefined ||
    staleEntryCount === undefined ||
    resultCount === undefined ||
    cacheEntryCount === undefined
  ) {
    return undefined;
  }

  return {
    startedAt,
    finishedAt,
    durationMs,
    filesProcessed,
    filesReparsed,
    cacheHitCount,
    cacheMissCount,
    staleEntryCount,
    resultCount,
    cacheEntryCount,
    extra: parseExtraDiagnostics(value.extra),
  };
}

function parseSessionCacheStats(value: unknown): SessionCacheRuntimeStats | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const totalRequests = readFiniteNumber(value.totalRequests);
  const coldLoadCount = readFiniteNumber(value.coldLoadCount);
  const freshHitCount = readFiniteNumber(value.freshHitCount);
  const staleHitCount = readFiniteNumber(value.staleHitCount);
  const waitForRefreshCount = readFiniteNumber(value.waitForRefreshCount);
  const waitForExistingRefreshHitCount = readFiniteNumber(value.waitForExistingRefreshHitCount) ?? 0;
  const refreshCount = readFiniteNumber(value.refreshCount);
  const foregroundRefreshCount = readFiniteNumber(value.foregroundRefreshCount);
  const backgroundRefreshCount = readFiniteNumber(value.backgroundRefreshCount);
  const refreshSuccessCount = readFiniteNumber(value.refreshSuccessCount);
  const refreshErrorCount = readFiniteNumber(value.refreshErrorCount);
  const inFlightJoinCount = readFiniteNumber(value.inFlightJoinCount);
  const invalidateCount = readFiniteNumber(value.invalidateCount);

  if (
    totalRequests === undefined ||
    coldLoadCount === undefined ||
    freshHitCount === undefined ||
    staleHitCount === undefined ||
    waitForRefreshCount === undefined ||
    refreshCount === undefined ||
    foregroundRefreshCount === undefined ||
    backgroundRefreshCount === undefined ||
    refreshSuccessCount === undefined ||
    refreshErrorCount === undefined ||
    inFlightJoinCount === undefined ||
    invalidateCount === undefined
  ) {
    return undefined;
  }

  const lastDecision = readString(value.lastDecision);
  const lastRefreshMode = readString(value.lastRefreshMode);

  return {
    totalRequests,
    coldLoadCount,
    freshHitCount,
    staleHitCount,
    waitForRefreshCount,
    waitForExistingRefreshHitCount,
    refreshCount,
    foregroundRefreshCount,
    backgroundRefreshCount,
    refreshSuccessCount,
    refreshErrorCount,
    inFlightJoinCount,
    invalidateCount,
    lastRequestAt: readString(value.lastRequestAt),
    lastRequestWaitForRefresh: readBoolean(value.lastRequestWaitForRefresh),
    lastDecision: lastDecision && SESSION_CACHE_DECISIONS.has(lastDecision as NonNullable<SessionCacheRuntimeStats['lastDecision']>)
      ? lastDecision as NonNullable<SessionCacheRuntimeStats['lastDecision']>
      : undefined,
    lastRefreshStartedAt: readString(value.lastRefreshStartedAt),
    lastRefreshFinishedAt: readString(value.lastRefreshFinishedAt),
    lastRefreshDurationMs: readFiniteNumber(value.lastRefreshDurationMs),
    lastRefreshMode: lastRefreshMode && SESSION_CACHE_REFRESH_MODES.has(lastRefreshMode as NonNullable<SessionCacheRuntimeStats['lastRefreshMode']>)
      ? lastRefreshMode as NonNullable<SessionCacheRuntimeStats['lastRefreshMode']>
      : undefined,
    lastInvalidateAt: readString(value.lastInvalidateAt),
  };
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

async function readSessionMetadataCacheFile<T>(
  options: LoadSessionMetadataCacheOptions,
): Promise<SessionMetadataCacheFile<T> | null> {
  const cachePath = getSessionMetadataCachePath(options.cacheFileName);

  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isRecord(parsed)) return null;
    if (parsed.version !== options.cacheVersion) return null;
    if (parsed.scopeKey !== options.scopeKey) return null;
    if (parsed.scopeValue !== options.scopeValue) return null;
    if (!isRecord(parsed.entries)) return null;

    return {
      version: options.cacheVersion,
      scopeKey: options.scopeKey,
      scopeValue: options.scopeValue,
      entries: parsed.entries as Record<string, T>,
      lastRun: parseLastRun(parsed.lastRun),
      sessionCache: parseSessionCacheStats(parsed.sessionCache),
    };
  } catch {
    return null;
  }
}

function buildSessionMetadataCachePayload<T>(options: {
  cacheVersion: number;
  scopeKey: string;
  scopeValue: string;
  entries: Record<string, T>;
  lastRun?: SessionMetadataCacheLastRun;
  sessionCache?: SessionCacheRuntimeStats;
}): Record<string, unknown> {
  return {
    version: options.cacheVersion,
    scopeKey: options.scopeKey,
    scopeValue: options.scopeValue,
    entries: options.entries,
    lastRun: options.lastRun,
    sessionCache: options.sessionCache,
  };
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
  const parsed = await readSessionMetadataCacheFile<T>(options);
  return parsed?.entries ?? {};
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

  try {
    const existing = await readSessionMetadataCacheFile<T>(options);
    const payload = buildSessionMetadataCachePayload({
      cacheVersion: options.cacheVersion,
      scopeKey: options.scopeKey,
      scopeValue: options.scopeValue,
      entries: options.entries,
      lastRun: options.lastRun ?? existing?.lastRun,
      sessionCache: options.sessionCache ?? existing?.sessionCache,
    });
    await writeCacheFileAtomically(cachePath, payload);
  } catch {
    // best-effort cache write
  } finally {
    await releaseCacheLock(lockFileHandle, lockPath);
  }
}

export async function updateSessionMetadataCacheDiagnostics(
  options: UpdateSessionMetadataCacheDiagnosticsOptions,
): Promise<void> {
  const cachePath = getSessionMetadataCachePath(options.cacheFileName);
  const lockPath = getCacheLockPath(cachePath);
  const lockFileHandle = await acquireCacheLock(lockPath);
  if (!lockFileHandle) {
    return;
  }

  try {
    const existing = await readSessionMetadataCacheFile<unknown>(options);
    const payload = buildSessionMetadataCachePayload({
      cacheVersion: options.cacheVersion,
      scopeKey: options.scopeKey,
      scopeValue: options.scopeValue,
      entries: existing?.entries ?? {},
      lastRun: options.lastRun ?? existing?.lastRun,
      sessionCache: options.sessionCache ?? existing?.sessionCache,
    });
    await writeCacheFileAtomically(cachePath, payload);
  } catch {
    // best-effort diagnostics write
  } finally {
    await releaseCacheLock(lockFileHandle, lockPath);
  }
}
