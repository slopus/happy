import fs from 'fs/promises';
import os from 'os';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './api/types';
import { MachineMetadata, DaemonState } from '@/api/types';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { Metadata } from '@/api/types';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState } from '@/persistence';

import { cleanupDaemonState, checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningSameVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';

// Prepare initial metadata
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir
};

export async function startDaemon(): Promise<void> {
  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningSameVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

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
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for `);
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
      let directoryCreated = false;
        
      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);
        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
          directoryCreated = true;
        } catch (mkdirError: any) {
          let errorMessage = `Unable to create directory at '${directory}'. `;
          
          // Provide more helpful error messages based on the error code
          if (mkdirError.code === 'EACCES') {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (mkdirError.code === 'ENOTDIR') {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (mkdirError.code === 'ENOSPC') {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (mkdirError.code === 'EROFS') {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
          }
          
          logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
          // Return null on error for cleaner API
          return null;
        }
      }

      try {
        const args = [
          '--happy-starting-mode', 'remote',
          '--started-by', 'daemon'
        ];

        // TODO: In future, sessionId could be used with --resume to continue existing sessions
        // For now, we ignore it - each spawn creates a new session
        const happyProcess = spawnHappyCLI(args, {
          cwd: directory,
          detached: true,  // Sessions stay alive when daemon stops
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
          childProcess: happyProcess,
          directoryCreated,
          message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
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

    // We don't have cleanup function at the time of server construction
    let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'unknown') => void;
    let resolvesWhenShutdownRequested = new Promise<('happy-app' | 'happy-cli' | 'os-signal' | 'unknown')>((resolve) => {
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

    // Write daemon state using persistence module
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: await logger.logFilePathPromise
    };
    await writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = new ApiClient(credentials.token, credentials.secret);

    // Get or create machine
    const machine = await api.createMachineOrGetExistingAsIs({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      requestShutdown: () => requestShutdown('happy-app')
    });

    // Connect to server
    apiMachine.connect();

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'unknown', restart: boolean = false) => {
      logger.debug(`[DAEMON RUN] Starting cleanup (source: ${source})...`);

      // Update daemon state before shutting down
      if (apiMachine) {
        await apiMachine.updateDaemonState((state: DaemonState | null) => ({
          ...state,
          status: 'shutting-down',
          shutdownRequestedAt: Date.now(),
          shutdownSource: source === 'happy-app' ? 'mobile-app' : source === 'happy-cli' ? 'cli' : source
        }));

        // Give time for metadata update to send
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Shutdown machine session
      if (apiMachine) {
        apiMachine.shutdown();
      }
      logger.debug('[DAEMON RUN] Machine session shutdown');

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Stop control server
      await stopControlServer();
      logger.debug('[DAEMON RUN] Control server stopped');

      // Clean up state
      await cleanupDaemonState();
      logger.debug('[DAEMON RUN] State cleaned up');

      // Stop caffeinate
      await stopCaffeinate();
      logger.debug('[DAEMON RUN] Caffeinate stopped');

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      
      // If restart requested, spawn new daemon before exiting
      if (restart) {
        logger.debug('[DAEMON RUN] Restarting daemon with latest version');
        spawnHappyCLI(['daemon', 'start-sync'], {
          detached: true,
          stdio: 'ignore'
        });
      }
      
      process.exit(0);
    };

    process.on('SIGINT', () => {
      logger.debug('[DAEMON RUN] Received SIGINT');
      cleanupAndShutdown('os-signal');
    });

    process.on('SIGTERM', () => {
      logger.debug('[DAEMON RUN] Received SIGTERM');
      cleanupAndShutdown('os-signal');
    });

    process.on('uncaughtException', (error) => {
      logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
      logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
      cleanupAndShutdown('unknown');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
      logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
      if (reason instanceof Error) {
        logger.debug(`[DAEMON RUN] Stack trace: ${reason.stack}`);
      }
      cleanupAndShutdown('unknown');
    });

    process.on('exit', (code) => {
      logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
    });

    process.on('beforeExit', (code) => {
      logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
    });

    logger.debug('[DAEMON RUN] Daemon started successfully');

    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      logger.debug('[DAEMON RUN] Starting healing process - prune stale sessions and check for CLI version update & restart if needed');
      
      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
        }
      }
      
      // Check if daemon needs update
      const isLatestVersion = await isDaemonRunningSameVersion();
      if (!isLatestVersion) {
        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version');
        
        // Spawn new daemon through the CLI
        spawnHappyCLI(['daemon', 'start'], {
          detached: true,
          stdio: 'ignore'
        });

        // We do not need to clean ourselves up - we will be killed by
        // the CLI start command. It will first check if daemon is running (yes in this case)
        // if the version is stale - kill it - that is our destiny
        // Next it will start a new daemon with the latest version with daemon-sync :D
        // Done!

        // So we can just hang forever
        logger.debug('[DAEMON RUN] Hanging forever - waiting for CLI to kill us because we are running outdated version of the code');
        await new Promise(() => {});
      }
      
      // Then write heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath
        };
        await writeDaemonState(updatedState);
        logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }
    }, 60000); // Every 60 seconds

    // Wait for shutdown request
    const shutdownSource = await resolvesWhenShutdownRequested;
    logger.debug(`[DAEMON RUN] Shutdown requested (source: ${shutdownSource})`);
    await cleanupAndShutdown(shutdownSource);
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to start daemon', error);
    await cleanupDaemonState();
    stopCaffeinate();
    process.exit(1);
  }
}
