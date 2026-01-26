import type { TrackedSession } from './types';

export async function stopTrackedSessionById(opts: {
  pidToTrackedSession: Map<number, TrackedSession>;
  sessionId: string;
  isPidSafeHappySessionProcess: (args: { pid: number; expectedProcessCommandHash?: string }) => Promise<boolean>;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<boolean> {
  const normalized = opts.sessionId.startsWith('PID-') ? opts.sessionId.replace('PID-', '') : null;
  const requestedPid = normalized ? Number.parseInt(normalized, 10) : null;

  for (const [pid, session] of opts.pidToTrackedSession.entries()) {
    const matches =
      session.happySessionId === opts.sessionId || (requestedPid !== null && Number.isFinite(requestedPid) && pid === requestedPid);
    if (!matches) continue;

    if (session.startedBy === 'daemon' && session.childProcess) {
      try {
        session.childProcess.kill('SIGTERM');
      } catch {
        // ignore
      }
      return true;
    }

    const safe = await opts.isPidSafeHappySessionProcess({ pid, expectedProcessCommandHash: session.processCommandHash });
    if (!safe) {
      return false;
    }

    try {
      opts.killPid(pid, 'SIGTERM');
    } catch {
      // ignore
    }

    return true;
  }

  return false;
}

