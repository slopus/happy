import { describe, expect, it, vi } from 'vitest';
import type { TrackedSession } from './types';

describe('stopTrackedSessionById', () => {
  it('sends SIGTERM to daemon-spawned sessions without dropping tracking', async () => {
    const childProcess = { kill: vi.fn() } as any;
    const session: TrackedSession = {
      startedBy: 'daemon',
      pid: 123,
      happySessionId: 'sess_1',
      childProcess,
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[123, session]]);

    const { stopTrackedSessionById } = await import('./stopTrackedSessionById');
    const ok = await stopTrackedSessionById({
      pidToTrackedSession,
      sessionId: 'sess_1',
      isPidSafeHappySessionProcess: vi.fn(async () => true),
      killPid: vi.fn(),
    });

    expect(ok).toBe(true);
    expect(childProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(pidToTrackedSession.get(123)).toBe(session);
  });

  it('refuses to SIGTERM external sessions when PID safety fails', async () => {
    const session: TrackedSession = {
      startedBy: 'terminal',
      pid: 456,
      happySessionId: 'sess_2',
      processCommandHash: 'hash',
    };
    const pidToTrackedSession = new Map<number, TrackedSession>([[456, session]]);

    const { stopTrackedSessionById } = await import('./stopTrackedSessionById');
    const killPid = vi.fn();
    const ok = await stopTrackedSessionById({
      pidToTrackedSession,
      sessionId: 'sess_2',
      isPidSafeHappySessionProcess: vi.fn(async () => false),
      killPid,
    });

    expect(ok).toBe(false);
    expect(killPid).not.toHaveBeenCalled();
    expect(pidToTrackedSession.get(456)).toBe(session);
  });
});

