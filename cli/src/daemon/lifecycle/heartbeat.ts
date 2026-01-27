import { readFileSync } from 'fs';
import { join } from 'path';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { readDaemonState, writeDaemonState } from '@/persistence';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeSessionExitReport } from '@/daemon/sessionExitReport';

import { reportDaemonObservedSessionExit } from '../sessionTermination';
import type { TrackedSession } from '../types';
import { removeSessionMarker } from '../sessionRegistry';

export function startDaemonHeartbeatLoop(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  spawnResourceCleanupByPid: Map<number, () => void>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
  getApiMachineForSessions: () => ApiMachineClient | null;
  controlPort: number;
  fileState: DaemonLocallyPersistedState;
  currentCliVersion: string;
  requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
}>): NodeJS.Timeout {
  const {
    pidToTrackedSession,
    spawnResourceCleanupByPid,
    sessionAttachCleanupByPid,
    getApiMachineForSessions,
    controlPort,
    fileState,
    currentCliVersion,
    requestShutdown,
  } = params;

  // Every 60 seconds:
  // 1. Prune stale sessions
  // 2. Check if daemon needs update
  // 3. If outdated, restart with latest version
  // 4. Write heartbeat
  const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
  let heartbeatRunning = false;

  const intervalHandle = setInterval(async () => {
    if (heartbeatRunning) {
      return;
    }
    heartbeatRunning = true;

    if (process.env.DEBUG) {
      logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
    }

    // Prune stale sessions
    for (const [pid, _] of pidToTrackedSession.entries()) {
      try {
        // Check if process is still alive (signal 0 doesn't kill, just checks)
        process.kill(pid, 0);
      } catch (error) {
        // Process is dead, remove from tracking
        logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
        const tracked = pidToTrackedSession.get(pid);
        if (tracked) {
          const apiMachine = getApiMachineForSessions();
          if (apiMachine) {
            reportDaemonObservedSessionExit({
              apiMachine,
              trackedSession: tracked,
              now: () => Date.now(),
              exit: { reason: 'process-missing', code: null, signal: null },
            });
          }
        void writeSessionExitReport({
          sessionId: tracked.happySessionId ?? null,
          pid,
          report: {
              observedAt: Date.now(),
              observedBy: 'daemon',
              reason: 'process-missing',
              code: null,
              signal: null,
            },
          }).catch((e) => logger.debug('[DAEMON RUN] Failed to write session exit report', e));
        }
        const cleanup = spawnResourceCleanupByPid.get(pid);
        if (cleanup) {
          spawnResourceCleanupByPid.delete(pid);
          try {
            cleanup();
          } catch (cleanupError) {
            logger.debug('[DAEMON RUN] Failed to cleanup spawn resources', cleanupError);
          }
        }
        const attachCleanup = sessionAttachCleanupByPid.get(pid);
        if (attachCleanup) {
          sessionAttachCleanupByPid.delete(pid);
          try {
            await attachCleanup();
          } catch (cleanupError) {
            logger.debug('[DAEMON RUN] Failed to cleanup session attach file', cleanupError);
          }
        }
        pidToTrackedSession.delete(pid);
        void removeSessionMarker(pid);
      }
    }

    // Cleanup any spawn resources for sessions no longer tracked (e.g. stopSession removed them).
    for (const [pid, cleanup] of spawnResourceCleanupByPid.entries()) {
      if (pidToTrackedSession.has(pid)) continue;
      try {
        process.kill(pid, 0);
      } catch {
        spawnResourceCleanupByPid.delete(pid);
        try {
          cleanup();
        } catch (cleanupError) {
          logger.debug('[DAEMON RUN] Failed to cleanup spawn resources', cleanupError);
        }
      }
    }

    for (const [pid, cleanup] of sessionAttachCleanupByPid.entries()) {
      if (pidToTrackedSession.has(pid)) continue;
      try {
        process.kill(pid, 0);
      } catch {
        sessionAttachCleanupByPid.delete(pid);
        try {
          await cleanup();
        } catch (cleanupError) {
          logger.debug('[DAEMON RUN] Failed to cleanup session attach file', cleanupError);
        }
      }
    }

    // Check if daemon needs update
    // If version on disk is different from the one in package.json - we need to restart
    // BIG if - does this get updated from underneath us on npm upgrade?
    const projectVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
    if (projectVersion !== currentCliVersion) {
      logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version, clearing heartbeat interval');

      clearInterval(intervalHandle);

      // Spawn new daemon through the CLI
      // We do not need to clean ourselves up - we will be killed by
      // the CLI start command.
      // 1. It will first check if daemon is running (yes in this case)
      // 2. If the version is stale (it will read daemon.state.json file and check startedWithCliVersion) & compare it to its own version
      // 3. Next it will start a new daemon with the latest version with daemon-sync :D
      // Done!
      try {
        spawnHappyCLI(['daemon', 'start'], {
          detached: true,
          stdio: 'ignore'
        });
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
      }

      // So we can just hang forever
      logger.debug('[DAEMON RUN] Hanging for a bit - waiting for CLI to kill us because we are running outdated version of the code');
      await new Promise(resolve => setTimeout(resolve, 10_000));
      process.exit(0);
    }

    // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
    // Race condition is possible, but thats okay for the time being :D
    const daemonState = await readDaemonState();
    if (daemonState && daemonState.pid !== process.pid) {
      logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
      requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
    }

    // Heartbeat
    try {
      const updatedState: DaemonLocallyPersistedState = {
        pid: process.pid,
        httpPort: controlPort,
        startTime: fileState.startTime,
        startedWithCliVersion: fileState.startedWithCliVersion,
        lastHeartbeat: new Date().toLocaleString(),
        daemonLogPath: fileState.daemonLogPath
      };
      writeDaemonState(updatedState);
      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
      }
    } catch (error) {
      logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
    }

    heartbeatRunning = false;
  }, heartbeatIntervalMs); // Every 60 seconds in production

  return intervalHandle;
}
