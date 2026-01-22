/**
 * Opt-in daemon reattach integration tests.
 *
 * These tests spawn real processes and rely on `ps-list` classification.
 *
 * Enable with: `HAPPY_CLI_DAEMON_REATTACH_INTEGRATION=1`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Metadata } from '@/api/types';

function shouldRunDaemonReattachIntegration(): boolean {
  return process.env.HAPPY_CLI_DAEMON_REATTACH_INTEGRATION === '1';
}

function spawnHappyLookingProcess(): { pid: number; kill: () => void } {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000_000)', 'happy-cli', '--started-by', 'daemon'],
    { stdio: 'ignore' },
  );
  if (!child.pid) throw new Error('Failed to spawn test process');
  return {
    pid: child.pid,
    kill: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    },
  };
}

describe.skipIf(!shouldRunDaemonReattachIntegration())(
  'reattach (real) integration tests (opt-in)',
  { timeout: 20_000 },
  () => {
    const originalHappyHomeDir = process.env.HAPPY_HOME_DIR;
    const spawned: Array<() => void> = [];
    const tempHomes: string[] = [];

    beforeEach(() => {
      const home = mkdtempSync(join(tmpdir(), 'happy-cli-daemon-reattach-test-'));
      tempHomes.push(home);
      process.env.HAPPY_HOME_DIR = home;
      vi.resetModules();
    });

    afterEach(() => {
      for (const k of spawned.splice(0)) k();
      for (const home of tempHomes.splice(0)) {
        rmSync(home, { recursive: true, force: true });
      }
      if (originalHappyHomeDir === undefined) {
        delete process.env.HAPPY_HOME_DIR;
      } else {
        process.env.HAPPY_HOME_DIR = originalHappyHomeDir;
      }
      vi.resetModules();
    });

    it('adopts a marker only when PID is alive and command hash matches', async () => {
      const { adoptSessionsFromMarkers } = await import('./reattach');
      const { findAllHappyProcesses, findHappyProcessByPid } = await import('./doctor');
      const { hashProcessCommand, listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

      const p = spawnHappyLookingProcess();
      spawned.push(p.kill);

      // Wait for ps-list to see it (best-effort).
      const start = Date.now();
      let proc = null as Awaited<ReturnType<typeof findHappyProcessByPid>>;
      while (Date.now() - start < 5_000) {
        proc = await findHappyProcessByPid(p.pid);
        if (proc) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(proc).not.toBeNull();
      if (!proc) return;

      const metadata: Metadata = {
        path: '/tmp',
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: process.env.HAPPY_HOME_DIR!,
        happyLibDir: '/tmp',
        happyToolsDir: '/tmp',
        hostPid: p.pid,
        startedBy: 'terminal',
        machineId: 'test-machine',
      };

      await writeSessionMarker({
        pid: p.pid,
        happySessionId: 'sess-1',
        startedBy: 'terminal',
        cwd: '/tmp',
        processCommandHash: hashProcessCommand(proc.command),
        processCommand: proc.command,
        metadata,
      });

      const markers = await listSessionMarkers();
      expect(markers).toHaveLength(1);

      const happyProcesses = await findAllHappyProcesses();
      const map = new Map<number, any>();
      const { adopted } = adoptSessionsFromMarkers({ markers, happyProcesses, pidToTrackedSession: map });
      expect(adopted).toBe(1);
      expect(map.get(p.pid)?.reattachedFromDiskMarker).toBe(true);
      expect(map.get(p.pid)?.processCommandHash).toBe(hashProcessCommand(proc.command));
    });

    it('does not adopt when marker hash mismatches (fail-closed)', async () => {
      const { adoptSessionsFromMarkers } = await import('./reattach');
      const { findAllHappyProcesses, findHappyProcessByPid } = await import('./doctor');
      const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

      const p = spawnHappyLookingProcess();
      spawned.push(p.kill);

      // Wait until ps-list sees the process (avoid flakiness).
      const start = Date.now();
      let proc = null as Awaited<ReturnType<typeof findHappyProcessByPid>>;
      while (Date.now() - start < 5_000) {
        proc = await findHappyProcessByPid(p.pid);
        if (proc) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(proc).not.toBeNull();
      if (!proc) return;

      await writeSessionMarker({
        pid: p.pid,
        happySessionId: 'sess-2',
        startedBy: 'terminal',
        processCommandHash: '0'.repeat(64),
        processCommand: proc.command,
      });

      const markers = await listSessionMarkers();
      const happyProcesses = await findAllHappyProcesses();
      const map = new Map<number, any>();
      const { adopted } = adoptSessionsFromMarkers({ markers, happyProcesses, pidToTrackedSession: map });
      expect(adopted).toBe(0);
      expect(map.size).toBe(0);
    });
  },
);

