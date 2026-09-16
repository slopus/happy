import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCodexHistoryCacheLock } from './codexHistoryIndex';

let sqliteAvailable = false;
try { createRequire(import.meta.url)('node:sqlite'); sqliteAvailable = true; } catch { /* Node 20 has legacy history only. */ }

describe('Codex account history cache lock', () => {
  it.skipIf(!sqliteAvailable)('serializes independent database connections and releases after failures', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-index-lock-'));
    try {
      const events: string[] = [];
      let release!: () => void;
      let entered!: () => void;
      const firstEntered = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const first = withCodexHistoryCacheLock(home, async () => {
        events.push('first'); entered(); await gate; events.push('first-done');
      });
      await firstEntered;
      const second = withCodexHistoryCacheLock(home, async () => { events.push('second'); });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(events).toEqual(['first']);
      release(); await Promise.all([first, second]);
      expect(events).toEqual(['first', 'first-done', 'second']);
      await expect(withCodexHistoryCacheLock(home, async () => { throw new Error('failed'); })).rejects.toThrow('failed');
      await expect(withCodexHistoryCacheLock(home, async () => 'released')).resolves.toBe('released');
    } finally { await rm(home, {recursive:true, force:true}); }
  });
});
