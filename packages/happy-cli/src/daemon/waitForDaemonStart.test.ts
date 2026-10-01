import { describe, expect, it } from 'vitest';
import { waitForDaemonStart } from './waitForDaemonStart';

/** exit: [after this many checks, exit code] — null code means killed by a signal. */
function harness(runningAfterChecks: number | null, exit: [number, number | null] | null = null) {
  let clock = 0;
  let checks = 0;
  return {
    checks: () => checks,
    deps: {
      isRunning: async () => { checks++; return runningAfterChecks !== null && checks >= runningAfterChecks; },
      childExit: () => exit !== null && checks >= exit[0] ? exit[1] : undefined,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
    },
  };
}

describe('waitForDaemonStart', () => {
  it('keeps waiting past 5s for a slow daemon (measured 6.9s on a Windows PC)', async () => {
    const h = harness(70);
    expect(await waitForDaemonStart(h.deps, { timeoutMs: 25_000, pollMs: 100 })).toBe('started');
  });

  it('fails as soon as start-sync exits with an error', async () => {
    const h = harness(null, [3, 1]);
    expect(await waitForDaemonStart(h.deps, { timeoutMs: 25_000, pollMs: 100 })).toBe('exited');
    expect(h.checks()).toBe(3);
    const killed = harness(null, [2, null]);
    expect(await waitForDaemonStart(killed.deps, { timeoutMs: 25_000, pollMs: 100 })).toBe('exited');
  });

  it('keeps waiting when start-sync exits 0 after losing the lock to another starting daemon', async () => {
    const h = harness(23, [3, 0]);
    expect(await waitForDaemonStart(h.deps, { timeoutMs: 25_000, pollMs: 100 })).toBe('started');
  });

  it('still reports a daemon that came up right before its parent saw the exit', async () => {
    const h = harness(3, [3, 1]);
    expect(await waitForDaemonStart(h.deps, { timeoutMs: 25_000, pollMs: 100 })).toBe('started');
  });

  it('gives up at the timeout', async () => {
    const h = harness(null, [3, 0]);
    expect(await waitForDaemonStart(h.deps, { timeoutMs: 1_000, pollMs: 100 })).toBe('timeout');
    expect(h.checks()).toBe(11);
  });
});
