import type { ApiMachineClient } from '@/api/apiMachine';
import { logger } from '@/ui/logger';
import { writeSessionExitReport } from '@/daemon/sessionExitReport';

import type { TrackedSession } from '../types';
import { reportDaemonObservedSessionExit } from '../sessionTermination';
import { removeSessionMarker } from '../sessionRegistry';

export type ChildExit = { reason: string; code: number | null; signal: string | null };

export function createOnChildExited(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  spawnResourceCleanupByPid: Map<number, () => void>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
  getApiMachineForSessions: () => ApiMachineClient | null;
}>): (pid: number, exit: ChildExit) => void {
  const { pidToTrackedSession, spawnResourceCleanupByPid, sessionAttachCleanupByPid, getApiMachineForSessions } = params;

  return (pid: number, exit: ChildExit) => {
    logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
    const tracked = pidToTrackedSession.get(pid);
    if (tracked) {
      const apiMachineForSessions = getApiMachineForSessions();
      if (apiMachineForSessions) {
        reportDaemonObservedSessionExit({
          apiMachine: apiMachineForSessions,
          trackedSession: tracked,
          now: () => Date.now(),
          exit,
        });
      }
      void writeSessionExitReport({
        sessionId: tracked.happySessionId ?? null,
        pid,
        report: {
          observedAt: Date.now(),
          observedBy: 'daemon',
          reason: exit.reason,
          code: exit.code,
          signal: exit.signal,
        },
      }).catch((e) => logger.debug('[DAEMON RUN] Failed to write session exit report', e));
    }
    const cleanup = spawnResourceCleanupByPid.get(pid);
    if (cleanup) {
      spawnResourceCleanupByPid.delete(pid);
      try {
        cleanup();
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to cleanup spawn resources', error);
      }
    }
    const attachCleanup = sessionAttachCleanupByPid.get(pid);
    if (attachCleanup) {
      sessionAttachCleanupByPid.delete(pid);
      void attachCleanup().catch((error) => {
        logger.debug('[DAEMON RUN] Failed to cleanup session attach file', error);
      });
    }
    pidToTrackedSession.delete(pid);
    void removeSessionMarker(pid);
  };
}
