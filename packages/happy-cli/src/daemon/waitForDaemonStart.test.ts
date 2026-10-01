import { describe, expect, it } from 'vitest';
import { waitForDaemonStart } from './waitForDaemonStart';

function harness(runningAfterChecks: number | null, exitAfterChecks: number | null = null) {
  let clock = 0;
  let checks = 0;
  return {
    checks: () => checks,
    deps: {
      isRunning: async () => { checks++; return runningAfterChecks !== null && checks >= runningAfterChecks; },
      childExited: () => exitAfterChecks !== null && checks >= exitAfterChecks,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
    },
  };
}

describe('waitForDaemonStart', () => {
  it('keeps waiting past 5s for a slow daemon (measured 6.9s on a Windows PC)', async () => {
    const h = harness(70);
    expect(await waitForDaemonStart(h.deps, { timeoutMs: 45_000, pollMs: 100 })).toBe('started');
  });

  it('stops waiting as soon as the spawned daemon process exits', async () => {
    const h = harness(null, 3);
    expect(await waitForDaemonStart(h.deps, { timeoutMs: 45_000, pollMs: 100 })).toBe('exited');
    expect(h.checks()).toBe(3);
  });

  it('still reports a daemon that came up right before its parent saw the exit', async () => {
    const h = harness(3, 3);
    expect(await waitForDaemonStart(h.deps, { timeoutMs: 45_000, pollMs: 100 })).toBe('started');
  });

  it('gives up at the timeout', async () => {
    const h = harness(null);
    expect(await waitForDaemonStart(h.deps, { timeoutMs: 1_000, pollMs: 100 })).toBe('timeout');
    expect(h.checks()).toBe(11);
  });
});
