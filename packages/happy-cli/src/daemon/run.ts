import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readSettings, getActiveProfile, getEnvironmentVariables, validateProfileForAgent, getProfileEnvironmentVariables } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { readFileSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';

// Prepare initial metadata
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath()
};

// Get environment variables for a profile, filtered for agent compatibility
async function getProfileEnvironmentVariablesForAgent(
  profileId: string,
  agentType: 'claude' | 'codex' | 'gemini'
): Promise<Record<string, string>> {
  try {
    const settings = await readSettings();
    const profile = settings.profiles.find(p => p.id === profileId);

    if (!profile) {
      logger.debug(`[DAEMON RUN] Profile ${profileId} not found`);
      return {};
    }

    // Check if profile is compatible with the agent
    if (!validateProfileForAgent(profile, agentType)) {
      logger.debug(`[DAEMON RUN] Profile ${profileId} not compatible with agent ${agentType}`);
      return {};
    }

    // Get environment variables from profile (new schema)
    const envVars = getProfileEnvironmentVariables(profile);

    logger.debug(`[DAEMON RUN] Loaded ${Object.keys(envVars).length} environment variables from profile ${profileId} for agent ${agentType}`);
    return envVars;
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to get profile environment variables:', error);
    return {};
  }
}

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

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
      }
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

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
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      try {

        // Build environment variables with explicit precedence layers:
        // Layer 1 (base): Authentication tokens - protected, cannot be overridden
        // Layer 2 (middle): Profile environment variables - GUI profile OR CLI local profile
        // Layer 3 (top): Auth tokens again to ensure they're never overridden

        // Layer 1: Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = tmp.dirSync();

            // Write the token to the temporary directory
            fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

            // Set the environment variable for Codex
            authEnv.CODEX_HOME = codexHomeDir.name;
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        // Layer 2: Profile environment variables
        // Priority: GUI-provided profile > CLI local active profile > none
        let profileEnv: Record<string, string> = {};

        if (options.environmentVariables && Object.keys(options.environmentVariables).length > 0) {
          // GUI provided profile environment variables - highest priority for profile settings
          profileEnv = options.environmentVariables;
          logger.info(`[DAEMON RUN] Using GUI-provided profile environment variables (${Object.keys(profileEnv).length} vars)`);
          logger.debug(`[DAEMON RUN] GUI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
        } else {
          // Fallback to CLI local active profile
          try {
            const settings = await readSettings();
            if (settings.activeProfileId) {
              logger.debug(`[DAEMON RUN] No GUI profile provided, loading CLI local active profile: ${settings.activeProfileId}`);

              // Get profile environment variables filtered for agent compatibility
              profileEnv = await getProfileEnvironmentVariablesForAgent(
                settings.activeProfileId,
                options.agent || 'claude'
              );

              logger.debug(`[DAEMON RUN] Loaded ${Object.keys(profileEnv).length} environment variables from CLI local profile for agent ${options.agent || 'claude'}`);
              logger.debug(`[DAEMON RUN] CLI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
            } else {
              logger.debug('[DAEMON RUN] No CLI local active profile set');
            }
          } catch (error) {
            logger.debug('[DAEMON RUN] Failed to load CLI local profile environment variables:', error);
            // Continue without profile env vars - this is not a fatal error
          }
        }

        // Final merge: Profile vars first, then auth (auth takes precedence to protect authentication)
        let extraEnv = { ...profileEnv, ...authEnv };
        logger.debug(`[DAEMON RUN] Final environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        // Expand ${VAR} references from daemon's process.env
        // This ensures variable substitution works in both tmux and non-tmux modes
        // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
        extraEnv = expandEnvironmentVariables(extraEnv, process.env);
        logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

        // Fail-fast validation: Check that any auth variables present are fully expanded
        // Only validate variables that are actually set (different agents need different auth)
        const potentialAuthVars = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME', 'AZURE_OPENAI_API_KEY', 'TOGETHER_API_KEY'];
        const unexpandedAuthVars = potentialAuthVars.filter(varName => {
          const value = extraEnv[varName];
          // Only fail if variable IS SET and contains unexpanded ${VAR} references
          return value && typeof value === 'string' && value.includes('${');
        });

        if (unexpandedAuthVars.length > 0) {
          // Extract the specific missing variable names from unexpanded references
          const missingVarDetails = unexpandedAuthVars.map(authVar => {
            const value = extraEnv[authVar];
            const unresolvedMatch = value?.match(/\$\{([A-Z_][A-Z0-9_]*)(:-[^}]*)?\}/);
            const missingVar = unresolvedMatch ? unresolvedMatch[1] : 'unknown';
            return `${authVar} references \${${missingVar}} which is not defined`;
          });

          const errorMessage = `Authentication will fail - environment variables not found in daemon: ${missingVarDetails.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment (not just your shell) before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }

        // Check if tmux is available and should be used
        const tmuxAvailable = await isTmuxAvailable();
        let useTmux = tmuxAvailable;

        // Get tmux session name from environment variables (now set by profile system)
        // Empty string means "use current/most recent session" (tmux default behavior)
        let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;

        // If tmux is not available or session name is explicitly undefined, fall back to regular spawning
        // Note: Empty string is valid (means use current/most recent tmux session)
        if (!tmuxAvailable || tmuxSessionName === undefined) {
          useTmux = false;
          if (tmuxSessionName !== undefined) {
            logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
          }
        }

        if (useTmux && tmuxSessionName !== undefined) {
          // Try to spawn in tmux session
          const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, and gemini
          const agent = options.agent === 'gemini' ? 'gemini' : (options.agent === 'codex' ? 'codex' : 'claude');
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent} --happy-starting-mode remote --started-by daemon`;

          // Spawn in tmux with environment variables
          // IMPORTANT: Pass complete environment (process.env + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. Regular spawn uses env: { ...process.env, ...extraEnv }
          // 3. tmux needs explicit environment via -e flags to ensure all variables are available
          const windowName = `happy-${Date.now()}-${agent}`;
          const tmuxEnv: Record<string, string> = {};

          // Add all daemon environment variables (filtering out undefined)
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              tmuxEnv[key] = value;
            }
          }

          // Add extra environment variables (these should already be filtered)
          Object.assign(tmuxEnv, extraEnv);

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

            return new Promise((resolve) => {
              // Set timeout for webhook (same as regular flow)
              const timeout = setTimeout(() => {
                pidToAwaiter.delete(tmuxResult.pid!);
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.pid} (tmux)`);
                resolve({
                  type: 'error',
                  errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
                });
              }, 15_000); // Same timeout as regular sessions

              // Register awaiter for tmux session (exact same as regular flow)
              pidToAwaiter.set(tmuxResult.pid!, (completedSession) => {
                clearTimeout(timeout);
                logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
                resolve({
                  type: 'success',
                  sessionId: completedSession.happySessionId!
                });
              });
            });
          } else {
            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the CLI - support claude, codex, and gemini
          let agentCommand: string;
          switch (options.agent) {
            case 'claude':
            case undefined:
              agentCommand = 'claude';
              break;
            case 'codex':
              agentCommand = 'codex';
              break;
            case 'gemini':
              agentCommand = 'gemini';
              break;
            default:
              return {
                type: 'error',
                errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
              };
          }
          const args = [
            agentCommand,
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon'
          ];

          // TODO: In future, sessionId could be used with --resume to continue existing sessions
          // For now, we ignore it - each spawn creates a new session
          const happyProcess = spawnHappyCLI(args, {
            cwd: directory,
            detached: true,  // Sessions stay alive when daemon stops
            stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
            env: {
              ...process.env,
              ...extraEnv
            }
          });

          // Log output for debugging
          if (process.env.DEBUG) {
            happyProcess.stdout?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
            });
            happyProcess.stderr?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
            });
          }

          if (!happyProcess.pid) {
            logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
            return {
              type: 'error',
              errorMessage: 'Failed to spawn Happy process - no PID returned'
            };
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

          return new Promise((resolve) => {
            // Set timeout for webhook
            const timeout = setTimeout(() => {
              pidToAwaiter.delete(happyProcess.pid!);
              logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
              resolve({
                type: 'error',
                errorMessage: `Session webhook timeout for PID ${happyProcess.pid}`
              });
              // 15 second timeout - I have seen timeouts on 10 seconds
              // even though session was still created successfully in ~2 more seconds
            }, 15_000);

            // Register awaiter
            pidToAwaiter.set(happyProcess.pid!, (completedSession) => {
              clearTimeout(timeout);
              logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
              resolve({
                type: 'success',
                sessionId: completedSession.happySessionId!
              });
            });
          });
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
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

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const machine = await api.getOrCreateMachine({
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

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
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
          pidToTrackedSession.delete(pid);
        }
      }

      // Check if daemon needs update
      // If version on disk is different from the one in package.json - we need to restart
      // BIG if - does this get updated from underneath us on npm upgrade?
      const projectVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
      if (projectVersion !== configuration.currentCliVersion) {
        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version, clearing heartbeat interval');

        clearInterval(restartOnStaleVersionAndHeartbeat);

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
          startedWithCliVersion: packageJson.version,
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

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
