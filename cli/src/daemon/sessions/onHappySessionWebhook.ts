import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import { findHappyProcessByPid } from '../doctor';
import type { TrackedSession } from '../types';
import { hashProcessCommand, writeSessionMarker } from '../sessionRegistry';

export function createOnHappySessionWebhook(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
}>): (sessionId: string, sessionMetadata: Metadata) => void {
  const { pidToTrackedSession, pidToAwaiter } = params;

  return (sessionId: string, sessionMetadata: Metadata) => {
    logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

    // Safety: ignore cross-daemon/cross-stack reports.
    if (sessionMetadata?.happyHomeDir && sessionMetadata.happyHomeDir !== configuration.happyHomeDir) {
      logger.debug(`[DAEMON RUN] Ignoring session report for different happyHomeDir: ${sessionMetadata.happyHomeDir}`);
      return;
    }

    const pid = sessionMetadata.hostPid;
    if (!pid) {
      logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
      return;
    }

    logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
    logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

    // Check if we already have this PID (daemon-spawned)
    const existingSession = pidToTrackedSession.get(pid);

    if (existingSession && existingSession.startedBy === 'daemon') {
      // Update daemon-spawned session with reported data
      existingSession.happySessionId = sessionId;
      existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
      logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

      // Resolve any awaiter for this PID
      const awaiter = pidToAwaiter.get(pid);
      if (awaiter) {
        pidToAwaiter.delete(pid);
        awaiter(existingSession);
        logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
      }
    } else if (!existingSession) {
      // New session started externally
      const trackedSession: TrackedSession = {
        startedBy: 'happy directly - likely by user from terminal',
        happySessionId: sessionId,
        happySessionMetadataFromLocalWebhook: sessionMetadata,
        pid
      };
      pidToTrackedSession.set(pid, trackedSession);
      logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
    } else if (existingSession?.reattachedFromDiskMarker) {
      // Reattached sessions remain kill-protected (PID reuse safety), but we still keep metadata up to date.
      existingSession.startedBy = sessionMetadata.startedBy ?? existingSession.startedBy;
      existingSession.happySessionId = sessionId;
      existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
    }

    // Best-effort: write/update marker so future daemon restarts can reattach.
    // Also capture a process command hash so reattach/stop can be PID-reuse-safe.
    void (async () => {
      const proc = await findHappyProcessByPid(pid);
      const processCommandHash = proc?.command ? hashProcessCommand(proc.command) : undefined;
      if (processCommandHash) {
        // Store on the tracked session too so stopSession can require a match.
        const s = pidToTrackedSession.get(pid);
        if (s) s.processCommandHash = processCommandHash;
      } else {
        logger.debug(`[DAEMON RUN] Could not determine process command for PID ${pid}; marker will be weaker`);
      }

      await writeSessionMarker({
        pid,
        happySessionId: sessionId,
        startedBy: sessionMetadata.startedBy ?? 'terminal',
        cwd: sessionMetadata.path,
        processCommandHash,
        processCommand: proc?.command,
        metadata: sessionMetadata,
      });
    })().catch((e) => {
      logger.debug('[DAEMON RUN] Failed to write session marker', e);
    });
  };
}
