import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('listGeminiSessions', () => {
  let tempRoot: string;
  let happyHomeDir: string;
  let oldHappyHomeDir: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'gemini-session-reader-'));
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

  it('lists sessions and writes cache metadata', async () => {
    const sessionsDir = join(happyHomeDir, 'gemini_sessions');
    mkdirSync(sessionsDir, { recursive: true });

    const sessionId = 'gemini-session-a';
    const filePath = join(sessionsDir, `${sessionId}.jsonl`);
    const lines = [
      { type: 'meta', key: 'sessionStart', value: { cwd: '/workspace/happy' }, timestamp: 1710000000000 },
      { type: 'user', message: 'Need help with timeout optimization', uuid: 'u1', timestamp: 1710000001000 },
      { type: 'assistant', message: 'Sure, let us inspect that', uuid: 'a1', timestamp: 1710000002000 },
    ];
    writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    vi.resetModules();
    const { listGeminiSessions } = await import('./sessionReader');

    const sessions = await listGeminiSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(sessionId);
    expect(sessions[0].originalPath).toBe('/workspace/happy');
    expect(sessions[0].title).toBe('Need help with timeout optimization');
    expect(sessions[0].messageCount).toBe(1);

    const cachePath = join(happyHomeDir, 'gemini-session-metadata-cache.json');
    expect(existsSync(cachePath)).toBe(true);
    let cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cache.entries[sessionId].messageCount).toBe(1);
    expect(cache.lastRun.filesProcessed).toBe(1);
    expect(cache.lastRun.filesReparsed).toBe(1);
    expect(cache.lastRun.resultCount).toBe(1);
    expect(typeof cache.lastRun.durationMs).toBe('number');

    const firstFinishedAt = cache.lastRun.finishedAt;

    await listGeminiSessions();

    cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cache.lastRun.finishedAt).toBe(firstFinishedAt);
    expect(cache.lastRun.filesProcessed).toBe(1);
    expect(cache.lastRun.filesReparsed).toBe(1);
  });
});
