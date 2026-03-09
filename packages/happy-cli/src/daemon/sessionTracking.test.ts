import { describe, expect, it, vi } from 'vitest';

import { pruneStaleTrackedSessions } from './sessionTracking';
import { TrackedSession } from './types';

function makeSession(pid: number, overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    pid,
    startedBy: 'happy directly - likely by user from terminal',
    happySessionId: `session-${pid}`,
    ...overrides
  };
}

describe('pruneStaleTrackedSessions', () => {
  it('removes only dead sessions and returns the number pruned', () => {
    const tracked = new Map<number, TrackedSession>([
      [111, makeSession(111)],
      [222, makeSession(222)],
      [333, makeSession(333)]
    ]);

    const isPidAlive = vi.fn((pid: number) => pid !== 222);

    const removed = pruneStaleTrackedSessions(tracked, isPidAlive);

    expect(removed).toBe(1);
    expect(isPidAlive).toHaveBeenCalledTimes(3);
    expect(Array.from(tracked.keys())).toEqual([111, 333]);
  });

  it('treats invalid pids as stale when using a custom liveness check', () => {
    const tracked = new Map<number, TrackedSession>([
      [0, makeSession(0)],
      [-1, makeSession(-1)],
      [444, makeSession(444)]
    ]);

    const removed = pruneStaleTrackedSessions(tracked, (pid) => pid === 444);

    expect(removed).toBe(2);
    expect(Array.from(tracked.keys())).toEqual([444]);
  });
});
