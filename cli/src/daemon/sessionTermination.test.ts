import { describe, expect, it, vi } from 'vitest';
import type { TrackedSession } from './types';

describe('daemon session termination reporting', () => {
  it('emits session-end when sessionId is known', async () => {
    const apiMachine = {
      emitSessionEnd: vi.fn(),
    };

    const { reportDaemonObservedSessionExit } = await import('./sessionTermination');

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 123,
      happySessionId: 'sess_1',
    };

    const now = 1710000000000;
    reportDaemonObservedSessionExit({
      apiMachine,
      trackedSession: tracked,
      now: () => now,
      exit: { reason: 'process-missing' },
    });

    expect(apiMachine.emitSessionEnd).toHaveBeenCalledWith({
      sid: 'sess_1',
      time: now,
      exit: expect.objectContaining({
        observedBy: 'daemon',
        reason: 'process-missing',
        pid: 123,
      }),
    });
  });

  it('does not emit session-end when sessionId is unknown', async () => {
    const apiMachine = {
      emitSessionEnd: vi.fn(),
    };

    const { reportDaemonObservedSessionExit } = await import('./sessionTermination');

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 123,
    };

    reportDaemonObservedSessionExit({
      apiMachine,
      trackedSession: tracked,
      now: () => 1,
      exit: { reason: 'process-missing' },
    });

    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
  });
});
