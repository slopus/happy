import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('listCodexSessions', () => {
  let tempRoot: string;
  let happyHomeDir: string;
  let codexHomeDir: string;
  let oldHappyHomeDir: string | undefined;
  let oldCodexHomeDir: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'codex-session-reader-'));
    happyHomeDir = join(tempRoot, 'happy-home');
    codexHomeDir = join(tempRoot, 'codex-home');
    mkdirSync(happyHomeDir, { recursive: true });
    mkdirSync(codexHomeDir, { recursive: true });

    oldHappyHomeDir = process.env.HAPPY_HOME_DIR;
    oldCodexHomeDir = process.env.CODEX_HOME;
    process.env.HAPPY_HOME_DIR = happyHomeDir;
    process.env.CODEX_HOME = codexHomeDir;
  });

  afterEach(() => {
    if (oldHappyHomeDir === undefined) {
      delete process.env.HAPPY_HOME_DIR;
    } else {
      process.env.HAPPY_HOME_DIR = oldHappyHomeDir;
    }

    if (oldCodexHomeDir === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHomeDir;
    }

    vi.resetModules();
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('lists codex sessions and writes cache metadata', async () => {
    const sessionUuid = '11111111-2222-3333-4444-555555555555';
    const codexSessionsDir = join(codexHomeDir, 'sessions', '2026', '03', '11');
    mkdirSync(codexSessionsDir, { recursive: true });
    const filePath = join(codexSessionsDir, `rollout-2026-03-11T000000-${sessionUuid}.jsonl`);

    const lines = [
      {
        type: 'session_meta',
        payload: {
          id: sessionUuid,
          cwd: '/workspace/happy',
          git: { branch: 'main' },
          timestamp: '2026-03-11T00:00:00.000Z',
        },
        timestamp: '2026-03-11T00:00:00.000Z',
      },
      {
        type: 'response_item',
        payload: {
          role: 'user',
          content: [{ type: 'input_text', text: 'Please optimize Codex session listing speed' }],
        },
        timestamp: '2026-03-11T00:00:01.000Z',
      },
      {
        type: 'response_item',
        payload: {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Working on it' }],
        },
        timestamp: '2026-03-11T00:00:02.000Z',
      },
    ];
    writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    vi.resetModules();
    const { listCodexSessions } = await import('./codexSessionReader');

    const sessions = await listCodexSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('555555');
    expect(sessions[0].originalPath).toBe('/workspace/happy');
    expect(sessions[0].title).toBe('Please optimize Codex session listing speed');
    expect(sessions[0].messageCount).toBe(1);
    expect(sessions[0].gitBranch).toBe('main');

    const cachePath = join(happyHomeDir, 'codex-session-metadata-cache.json');
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cache.entries[filePath].sessionId).toBe('555555');
    expect(cache.lastRun.filesProcessed).toBe(1);
    expect(cache.lastRun.filesReparsed).toBe(1);
    expect(cache.lastRun.resultCount).toBe(1);
  });
});
