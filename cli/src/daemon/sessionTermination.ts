import type { TrackedSession } from './types';

type DaemonObservedExit = {
  reason: string;
  code?: number | null;
  signal?: string | null;
};

export function reportDaemonObservedSessionExit(opts: {
  apiMachine: { emitSessionEnd: (payload: any) => void };
  trackedSession: TrackedSession;
  now: () => number;
  exit: DaemonObservedExit;
}) {
  const { apiMachine, trackedSession, now, exit } = opts;

  if (!trackedSession.happySessionId) {
    return;
  }

  apiMachine.emitSessionEnd({
    sid: trackedSession.happySessionId,
    time: now(),
    exit: {
      observedBy: 'daemon',
      pid: trackedSession.pid,
      reason: exit.reason,
      code: exit.code ?? null,
      signal: exit.signal ?? null,
    },
  });
}
