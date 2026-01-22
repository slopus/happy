/**
 * Opt-in daemon reattach integration tests.
 *
 * These tests spawn real processes and rely on `ps-list` classification.
 *
 * Enable with: `HAPPY_CLI_DAEMON_REATTACH_INTEGRATION=1`
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { isPidSafeHappySessionProcess } from './pidSafety';
import { findHappyProcessByPid } from './doctor';
import { hashProcessCommand } from './sessionRegistry';

function shouldRunDaemonReattachIntegration(): boolean {
  return process.env.HAPPY_CLI_DAEMON_REATTACH_INTEGRATION === '1';
}

function spawnHappyLookingProcess(): { pid: number; kill: () => void } {
  // Important: We need `ps-list` to classify this as a Happy session process.
  // `doctor.classifyHappyProcess` considers a process "happy" if cmd includes "happy-cli",
  // and marks it as daemon-spawned-session if cmd includes "--started-by daemon".
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

async function waitForHappyProcess(pid: number, timeoutMs: number): Promise<Awaited<ReturnType<typeof findHappyProcessByPid>>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const proc = await findHappyProcessByPid(pid);
    if (proc) return proc;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

describe.skipIf(!shouldRunDaemonReattachIntegration())('pidSafety (real) integration tests (opt-in)', { timeout: 20_000 }, () => {
  const spawned: Array<() => void> = [];

  afterEach(() => {
    for (const k of spawned.splice(0)) k();
  });

  it('returns true when PID is a Happy session process and command hash matches', async () => {
    const p = spawnHappyLookingProcess();
    spawned.push(p.kill);

    const proc = await waitForHappyProcess(p.pid, 5_000);
    expect(proc).not.toBeNull();
    if (!proc) return;

    const expected = hashProcessCommand(proc.command);
    await expect(isPidSafeHappySessionProcess({ pid: p.pid, expectedProcessCommandHash: expected })).resolves.toBe(true);
  });

  it('returns false when command hash mismatches (PID reuse safety)', async () => {
    const p = spawnHappyLookingProcess();
    spawned.push(p.kill);

    const proc = await waitForHappyProcess(p.pid, 5_000);
    expect(proc).not.toBeNull();
    if (!proc) return;

    const wrong = '0'.repeat(64);
    expect(hashProcessCommand(proc.command)).not.toBe(wrong);
    await expect(isPidSafeHappySessionProcess({ pid: p.pid, expectedProcessCommandHash: wrong })).resolves.toBe(false);
  });
});

