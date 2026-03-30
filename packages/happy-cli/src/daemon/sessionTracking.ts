import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

import type { TrackedSession } from './types';

export const EXTERNALLY_STARTED_SESSION_LABEL = 'happy directly - likely by user from terminal';

export function onHappySessionWebhook(
  pidToTrackedSession: Map<number, TrackedSession>,
  pidToAwaiter: Map<number, (session: TrackedSession) => void>,
  sessionId: string,
  sessionMetadata: Metadata,
): void {
  logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

  const pid = sessionMetadata.hostPid;
  if (!pid) {
    logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
    return;
  }

  logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
  logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

  const existingSession = pidToTrackedSession.get(pid);

  if (existingSession && existingSession.startedBy === 'daemon') {
    existingSession.happySessionId = sessionId;
    existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
    logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

    const awaiter = pidToAwaiter.get(pid);
    if (awaiter) {
      pidToAwaiter.delete(pid);
      awaiter(existingSession);
      logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
    }
    return;
  }

  if (existingSession && existingSession.happySessionId !== sessionId) {
    const previousSessionId = existingSession.happySessionId;
    existingSession.happySessionId = sessionId;
    existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
    logger.debug(`[DAEMON RUN] Updated tracked session for PID ${pid}: ${previousSessionId ?? 'unknown'} → ${sessionId}`);
    return;
  }

  if (!existingSession) {
    const trackedSession: TrackedSession = {
      startedBy: EXTERNALLY_STARTED_SESSION_LABEL,
      happySessionId: sessionId,
      happySessionMetadataFromLocalWebhook: sessionMetadata,
      pid,
    };
    pidToTrackedSession.set(pid, trackedSession);
    logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
    return;
  }

  logger.debug(`[DAEMON RUN] Ignoring duplicate webhook for PID ${pid} and session ${sessionId}`);
}

export function stopTrackedSession(
  pidToTrackedSession: Map<number, TrackedSession>,
  sessionId: string,
  killExternalProcess: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal),
): boolean {
  logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

  for (const [pid, session] of pidToTrackedSession.entries()) {
    if (session.happySessionId === sessionId || (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', ''), 10))) {
      if (session.startedBy === 'daemon' && session.childProcess) {
        try {
          session.childProcess.kill('SIGTERM');
          logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
        } catch (error) {
          logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
        }
      } else {
        try {
          killExternalProcess(pid, 'SIGTERM');
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
}
