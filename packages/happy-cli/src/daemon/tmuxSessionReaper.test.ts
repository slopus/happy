import { describe, expect, it } from 'vitest';

import { createSessionCapacityLimiter } from './sessionCapacity';
import { reapClosedTmuxSessions } from './tmuxSessionReaper';
import type { TrackedSession } from './types';

describe('reapClosedTmuxSessions', () => {
  it('releases capacity when a tmux window closes even if its pane PID still appears alive', async () => {
    const sessions = new Map<number, TrackedSession>([[
      1234,
      { startedBy: 'daemon', pid: 1234, tmuxSessionId: 'work:happy-1234-claude' },
    ]]);
    const capacity = createSessionCapacityLimiter({
      maxConcurrentSessions: 1,
      countActiveSessions: () => Array.from(sessions.values())
        .filter((session) => session.startedBy === 'daemon').length,
    });

    expect(capacity.tryReserve()).toBeNull();

    const reaped = await reapClosedTmuxSessions({
      sessions,
      isWindowAlive: async () => false,
      onSessionExited: (pid) => sessions.delete(pid),
    });

    expect(reaped).toBe(1);
    expect(capacity.tryReserve()).not.toBeNull();
  });

  it('keeps a session when tmux liveness cannot be determined', async () => {
    const session: TrackedSession = {
      startedBy: 'daemon',
      pid: 1234,
      tmuxSessionId: 'work:happy-1234-claude',
    };
    const sessions = new Map([[session.pid, session]]);

    const reaped = await reapClosedTmuxSessions({
      sessions,
      isWindowAlive: async () => undefined,
      onSessionExited: (pid) => sessions.delete(pid),
    });

    expect(reaped).toBe(0);
    expect(sessions.get(session.pid)).toBe(session);
  });

  it('keeps a session when the tmux liveness check fails', async () => {
    const session: TrackedSession = {
      startedBy: 'daemon',
      pid: 1234,
      tmuxSessionId: 'work:happy-1234-claude',
    };
    const sessions = new Map([[session.pid, session]]);

    const reaped = await reapClosedTmuxSessions({
      sessions,
      isWindowAlive: async () => { throw new Error('tmux unavailable'); },
      onSessionExited: (pid) => sessions.delete(pid),
    });

    expect(reaped).toBe(0);
    expect(sessions.get(session.pid)).toBe(session);
  });
});
