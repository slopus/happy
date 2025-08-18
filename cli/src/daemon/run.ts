import { DaemonHappyServerSession } from './api/serverSession';
import { startDaemonControlServer } from './controlServer';
import { DaemonState, TrackedSession } from './api/types';
import { MachineMetadata } from '@/api/types';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { join } from 'path';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawn } from 'child_process';
import { projectPath } from '@/projectPath';
import { atomicFileWrite } from '@/utils/fileAtomic';
import { Metadata } from '@/api/types';
import { getDaemonState, cleanupDaemonState } from './utils';

export async function startDaemon(): Promise<void> {
  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  const runningDaemon = await getDaemonState();
  if (runningDaemon) {
    try {
      process.kill(runningDaemon.pid, 0);
      logger.debug('[DAEMON RUN] Daemon already running');
      process.exit(0);
    } catch {
      logger.debug('[DAEMON RUN] Stale state found, cleaning up');
      await cleanupDaemonState();
    }
  }

  // Start caffeinate
  const caffeinateStarted = startCaffeinate();
  if (caffeinateStarted) {
    logger.debug('[DAEMON RUN] Sleep prevention enabled');
  }

  try {
    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for session ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);

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
      }
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (directory: string, sessionId?: string): Promise<TrackedSession | null> => {
      try {
        const happyBinPath = join(projectPath(), 'bin', 'happy.mjs');
        const args = [
          '--happy-starting-mode', 'remote',
          '--started-by', 'daemon'
        ];

        // TODO: In future, sessionId could be used with --resume to continue existing sessions
        // For now, we ignore it - each spawn creates a new session

        const fullCommand = `${happyBinPath} ${args.join(' ')}`;
        logger.debug(`[DAEMON RUN] Spawning: ${fullCommand} in ${directory}`);

        const happyProcess = spawn(happyBinPath, args, {
          cwd: directory,
          detached: false,  // Dies with daemon
          stdio: ['ignore', 'pipe', 'pipe']  // Capture stdout/stderr for debugging
          // env is inherited automatically from parent process
        });

        // Log output for debugging
        happyProcess.stdout?.on('data', (data) => {
          logger.debug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
        });
        happyProcess.stderr?.on('data', (data) => {
          logger.debug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
        });

        if (!happyProcess.pid) {
          logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
          return null;
        }

        logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

        const trackedSession: TrackedSession = {
          startedBy: 'daemon',
          pid: happyProcess.pid,
          childProcess: happyProcess
        };

        pidToTrackedSession.set(happyProcess.pid, trackedSession);

        happyProcess.on('exit', (code, signal) => {
          logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
          if (happyProcess.pid) {
            onChildExited(happyProcess.pid);
          }
        });

        happyProcess.on('error', (error) => {
          logger.debug(`[DAEMON RUN] Child process error:`, error);
          if (happyProcess.pid) {
            onChildExited(happyProcess.pid);
          }
        });

        // Wait for webhook to populate session with happySessionId
        logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

        return new Promise((resolve, reject) => {
          // Set timeout for webhook
          const timeout = setTimeout(() => {
            pidToAwaiter.delete(happyProcess.pid!);
            logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
            resolve(trackedSession); // Return incomplete session on timeout
          }, 10000); // 10 second timeout

          // Register awaiter
          pidToAwaiter.set(happyProcess.pid!, (completedSession) => {
            clearTimeout(timeout);
            logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
            resolve(completedSession);
          });
        });
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return null;
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
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

    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      pidToTrackedSession.delete(pid);
    };

    // Track server session for cleanup
    let serverSession: DaemonHappyServerSession | null = null;

    // Setup shutdown promise
    let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'unknown') => void;
    const shutdownPromise = new Promise<'happy-app' | 'happy-cli' | 'os-signal' | 'unknown'>((resolve) => {
      requestShutdown = resolve;
    });

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook
    });

    // Write daemon state atomically
    const state: DaemonState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toISOString(),
      startedWithCliVersion: packageJson.version
    };
    await atomicFileWrite(configuration.daemonStateFile, JSON.stringify(state, null, 2));
    logger.debug('[DAEMON RUN] Daemon state written');

    // Create server session with already-registered machine
    serverSession = new DaemonHappyServerSession(
      credentials,
      machineId,
      spawnSession,
      stopSession,
      () => requestShutdown('happy-app')
    );

    serverSession.connect();

    // Setup signal handlers
    const cleanup = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'unknown') => {
      logger.debug(`[DAEMON RUN] Starting cleanup (source: ${source})...`);

      // Update metadata before shutting down
      if (serverSession) {
        await serverSession.updateMachineMetadata({
          daemonLastKnownStatus: 'shutting-down',
          shutdownRequestedAt: Date.now(),
          shutdownSource: source
        } as Partial<MachineMetadata>);

        // Give time for metadata update to send
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Kill all daemon-spawned children
      let killedCount = 0;
      for (const session of pidToTrackedSession.values()) {
        if (session.startedBy === 'daemon' && session.childProcess) {
          try {
            session.childProcess.kill('SIGTERM');
            killedCount++;
          } catch { }
        }
      }
      logger.debug(`[DAEMON RUN] Killed ${killedCount} daemon-spawned children`);

      // Shutdown server session
      serverSession.shutdown();
      logger.debug('[DAEMON RUN] Server session shutdown');

      // Stop control server
      await stopControlServer();
      logger.debug('[DAEMON RUN] Control server stopped');

      // Clean up state
      await cleanupDaemonState();
      logger.debug('[DAEMON RUN] State cleaned up');

      // Stop caffeinate
      stopCaffeinate();
      logger.debug('[DAEMON RUN] Caffeinate stopped');

      process.exit(0);
    };

    process.on('SIGINT', () => {
      logger.debug('[DAEMON RUN] Received SIGINT');
      cleanup('os-signal');
    });

    process.on('SIGTERM', () => {
      logger.debug('[DAEMON RUN] Received SIGTERM');
      cleanup('os-signal');
    });

    process.on('exit', () => {
      logger.debug('[DAEMON RUN] Process exit - killing children');
      // Note: Only synchronous operations allowed in exit handler
      let killedCount = 0;
      for (const session of pidToTrackedSession.values()) {
        if (session.startedBy === 'daemon' && session.childProcess) {
          try {
            session.childProcess.kill('SIGTERM');
            killedCount++;
          } catch { }
        }
      }
      logger.debug(`[DAEMON RUN] Killed ${killedCount} daemon-spawned children on exit`);
    });

    process.on('uncaughtException', (error) => {
      logger.debug('[DAEMON RUN] Uncaught exception - cleaning up before crash', error);
      cleanup('unknown');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.debug('[DAEMON RUN] Unhandled rejection - cleaning up before crash', reason);
      cleanup('unknown');
    });

    logger.debug('[DAEMON RUN] Daemon started successfully');

    // Wait for shutdown request
    const shutdownSource = await shutdownPromise;
    logger.debug(`[DAEMON RUN] Shutdown requested (source: ${shutdownSource})`);

    // Cleanup and exit
    await cleanup(shutdownSource);

  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to start daemon', error);
    await cleanupDaemonState();
    stopCaffeinate();
    process.exit(1);
  }
}

