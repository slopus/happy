import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
  });
});
