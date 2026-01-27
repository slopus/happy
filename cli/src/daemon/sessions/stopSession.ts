import { logger } from '@/ui/logger';

import { isPidSafeHappySessionProcess } from '../pidSafety';
import type { TrackedSession } from '../types';

export function createStopSession(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
}>): (sessionId: string) => Promise<boolean> {
  const { pidToTrackedSession } = params;

  // Stop a session by sessionId or PID fallback
  return async (sessionId: string): Promise<boolean> => {
    logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

    // Try to find by sessionId first
    for (const [pid, session] of pidToTrackedSession.entries()) {
      if (session.happySessionId === sessionId ||
        (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

        if (session.startedBy === 'daemon' && session.childProcess) {
          try {
            session.childProcess.kill('SIGTERM');
            logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
          } catch (error) {
            logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
          }
        } else {
          // PID reuse safety: verify the PID still looks like a Happy session process (and matches hash if known).
          const safe = await isPidSafeHappySessionProcess({ pid, expectedProcessCommandHash: session.processCommandHash });
          if (!safe) {
            logger.warn(`[DAEMON RUN] Refusing to SIGTERM PID ${pid} for session ${sessionId} (PID reuse safety)`);
            return false;
          }
          // For externally started sessions, try to kill by PID
          try {
            process.kill(pid, 'SIGTERM');
            logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
          } catch (error) {
            logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
          }
        }

        pidToTrackedSession.delete(pid);
        logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
        return true;
      }
    }

    logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
    return false;
  };
}
