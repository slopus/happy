import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sessionMetadataCache', () => {
  let tempRoot: string;
  let happyHomeDir: string;
  let oldHappyHomeDir: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'session-metadata-cache-'));
    happyHomeDir = join(tempRoot, 'happy-home');
    mkdirSync(happyHomeDir, { recursive: true });

    oldHappyHomeDir = process.env.HAPPY_HOME_DIR;
    process.env.HAPPY_HOME_DIR = happyHomeDir;
  });

  afterEach(() => {
    if (oldHappyHomeDir === undefined) {
      delete process.env.HAPPY_HOME_DIR;
    } else {
      process.env.HAPPY_HOME_DIR = oldHappyHomeDir;
    }

    vi.resetModules();
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('replaces cache entries on save so stale keys can be removed by caller', async () => {
    vi.resetModules();
    const { loadSessionMetadataCache, saveSessionMetadataCache } = await import('./sessionMetadataCache');

    await saveSessionMetadataCache({
      cacheFileName: 'demo-cache.json',
      cacheVersion: 1,
      scopeKey: 'rootDir',
      scopeValue: '/tmp/root',
      entries: {
        a: { fileMtimeMs: 1, fileSize: 10 },
      },
    });

    await saveSessionMetadataCache({
      cacheFileName: 'demo-cache.json',
      cacheVersion: 1,
      scopeKey: 'rootDir',
      scopeValue: '/tmp/root',
      entries: {
        a: { fileMtimeMs: 11, fileSize: 110 },
      },
      lastRun: {
        startedAt: '2026-03-11T00:00:00.000Z',
        finishedAt: '2026-03-11T00:00:00.100Z',
        durationMs: 100,
        filesProcessed: 5,
        filesReparsed: 1,
        cacheHitCount: 4,
        cacheMissCount: 1,
        staleEntryCount: 1,
        resultCount: 1,
        cacheEntryCount: 1,
      },
    });

    const entries = await loadSessionMetadataCache<{ fileMtimeMs: number; fileSize: number }>({
      cacheFileName: 'demo-cache.json',
      cacheVersion: 1,
      scopeKey: 'rootDir',
      scopeValue: '/tmp/root',
    });

    expect(entries).toEqual({
      a: { fileMtimeMs: 11, fileSize: 110 },
    });

    const cache = JSON.parse(readFileSync(join(happyHomeDir, 'demo-cache.json'), 'utf8'));
    expect(cache.lastRun).toMatchObject({
      durationMs: 100,
      filesProcessed: 5,
      filesReparsed: 1,
      cacheHitCount: 4,
      cacheMissCount: 1,
      staleEntryCount: 1,
      resultCount: 1,
      cacheEntryCount: 1,
    });
  });

  it('updates session cache diagnostics without overwriting entries or lastRun', async () => {
    vi.resetModules();
    const { saveSessionMetadataCache, updateSessionMetadataCacheDiagnostics } = await import('./sessionMetadataCache');

    await saveSessionMetadataCache({
      cacheFileName: 'demo-cache.json',
      cacheVersion: 1,
      scopeKey: 'rootDir',
      scopeValue: '/tmp/root',
      entries: {
        a: { fileMtimeMs: 11, fileSize: 110 },
      },
      lastRun: {
        startedAt: '2026-03-11T00:00:00.000Z',
        finishedAt: '2026-03-11T00:00:00.100Z',
        durationMs: 100,
        filesProcessed: 5,
        filesReparsed: 1,
        cacheHitCount: 4,
        cacheMissCount: 1,
        staleEntryCount: 1,
        resultCount: 1,
        cacheEntryCount: 1,
      },
    });

    await updateSessionMetadataCacheDiagnostics({
      cacheFileName: 'demo-cache.json',
      cacheVersion: 1,
      scopeKey: 'rootDir',
      scopeValue: '/tmp/root',
      sessionCache: {
        totalRequests: 3,
        coldLoadCount: 1,
        freshHitCount: 1,
        staleHitCount: 1,
        waitForRefreshCount: 0,
        waitForExistingRefreshHitCount: 0,
        refreshCount: 2,
        foregroundRefreshCount: 1,
        backgroundRefreshCount: 1,
        refreshSuccessCount: 2,
        refreshErrorCount: 0,
        inFlightJoinCount: 0,
        invalidateCount: 0,
        lastDecision: 'stale-hit',
      },
    });

    const cache = JSON.parse(readFileSync(join(happyHomeDir, 'demo-cache.json'), 'utf8'));
    expect(cache.entries).toEqual({
      a: { fileMtimeMs: 11, fileSize: 110 },
    });
    expect(cache.lastRun.durationMs).toBe(100);
    expect(cache.sessionCache).toMatchObject({
      totalRequests: 3,
      refreshCount: 2,
      staleHitCount: 1,
      lastDecision: 'stale-hit',
    });
  });
});
