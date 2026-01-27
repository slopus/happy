import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sessionRegistry', () => {
  const originalHappyHomeDir = process.env.HAPPY_HOME_DIR;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happy-cli-session-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPY_HOME_DIR = happyHomeDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPY_HOME_DIR;
    } else {
      process.env.HAPPY_HOME_DIR = originalHappyHomeDir;
    }
  });

  it('should write a marker and preserve createdAt across updates', async () => {
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 12345,
      happySessionId: 'sess-1',
      startedBy: 'terminal',
      cwd: '/tmp',
    });

    const markers1 = await listSessionMarkers();
    expect(markers1).toHaveLength(1);
    expect(markers1[0].pid).toBe(12345);
    expect(markers1[0].happySessionId).toBe('sess-1');
    expect(markers1[0].happyHomeDir).toBe(configuration.happyHomeDir);
    expect(typeof markers1[0].createdAt).toBe('number');
    expect(typeof markers1[0].updatedAt).toBe('number');

    const createdAt1 = markers1[0].createdAt;
    const updatedAt1 = markers1[0].updatedAt;

    // Ensure updatedAt changes even on fast machines.
    await new Promise((r) => setTimeout(r, 2));

    await writeSessionMarker({
      pid: 12345,
      happySessionId: 'sess-2',
      startedBy: 'terminal',
      cwd: '/tmp',
    });

    const markers2 = await listSessionMarkers();
    expect(markers2).toHaveLength(1);
    expect(markers2[0].createdAt).toBe(createdAt1);
    expect(markers2[0].updatedAt).toBeGreaterThanOrEqual(updatedAt1);
    expect(markers2[0].happySessionId).toBe('sess-2');
  });

  it('should ignore markers with wrong happyHomeDir and tolerate invalid JSON', async () => {
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers } = await import('./sessionRegistry');

    const dir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    mkdirSync(dir, { recursive: true });
    // Write a marker with different happyHomeDir
    writeFileSync(
      join(dir, 'pid-111.json'),
      JSON.stringify({ pid: 111, happySessionId: 'x', happyHomeDir: '/other', createdAt: 1, updatedAt: 1 }, null, 2),
      'utf-8'
    );
    // Write invalid JSON
    writeFileSync(join(dir, 'pid-222.json'), '{', 'utf-8');

    const markers = await listSessionMarkers();
    expect(markers).toEqual([]);
  });

  it('removeSessionMarker should not throw if the marker does not exist', async () => {
    const { removeSessionMarker } = await import('./sessionRegistry');
    await expect(removeSessionMarker(99999)).resolves.toBeUndefined();
  });

  it('writes valid JSON payload shape to disk', async () => {
    const { configuration } = await import('@/configuration');
    const { writeSessionMarker } = await import('./sessionRegistry');

    // 64 hex chars (sha256)
    const processCommandHash = 'a'.repeat(64);

    await writeSessionMarker({
      pid: 54321,
      happySessionId: 'sess-xyz',
      startedBy: 'daemon',
      cwd: '/tmp',
      processCommandHash,
      processCommand: 'node dist/index.mjs --started-by daemon',
    });

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions', 'pid-54321.json');
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(54321);
    expect(parsed.happySessionId).toBe('sess-xyz');
    expect(parsed.happyHomeDir).toBe(configuration.happyHomeDir);
    expect(parsed.startedBy).toBe('daemon');
    expect(parsed.processCommandHash).toBe(processCommandHash);
    expect(parsed.processCommand).toBe('node dist/index.mjs --started-by daemon');
    expect(typeof parsed.createdAt).toBe('number');
    expect(typeof parsed.updatedAt).toBe('number');
  });

  it('supports opencode flavor markers', async () => {
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 777,
      happySessionId: 'sess-opencode',
      startedBy: 'terminal',
      flavor: 'opencode',
      cwd: '/tmp',
    });

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].pid).toBe(777);
    expect(markers[0].flavor).toBe('opencode');
  });
});
