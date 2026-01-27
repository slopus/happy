import fs from 'fs/promises';
import os from 'os';

import { ApiClient } from '@/api/api';
import type { ApiMachineClient } from '@/api/apiMachine';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/integrations/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { AGENTS, getVendorResumeSupport, resolveAgentCliSubcommand, resolveCatalogAgentId } from '@/backends/catalog';
import {
  writeDaemonState,
  DaemonLocallyPersistedState,
  acquireDaemonLock,
  releaseDaemonLock,
  readSettings,
  readCredentials,
} from '@/persistence';
import { createSessionAttachFile } from './sessionAttachFile';
import { getDaemonShutdownExitCode, getDaemonShutdownWatchdogTimeoutMs } from './shutdownPolicy';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { findHappyProcessByPid } from './doctor';
import { hashProcessCommand } from './sessionRegistry';
import { findRunningTrackedSessionById } from './findRunningTrackedSessionById';
import { reattachTrackedSessionsFromMarkers } from './sessions/reattachFromMarkers';
import { createOnHappySessionWebhook } from './sessions/onHappySessionWebhook';
import { createOnChildExited } from './sessions/onChildExited';
import { createStopSession } from './sessions/stopSession';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';
import { projectPath } from '@/projectPath';
import { selectPreferredTmuxSessionName, TmuxUtilities, isTmuxAvailable } from '@/integrations/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/terminalConfig';
import { validateEnvVarRecordStrict } from '@/terminal/envVarSanitization';

import { getPreferredHostName, initialMachineMetadata } from './machine/metadata';
export { initialMachineMetadata } from './machine/metadata';
import { createDaemonShutdownController } from './lifecycle/shutdown';
import { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
export { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  const { requestShutdown, resolvesWhenShutdownRequested } = createDaemonShutdownController();

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

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

  // If this daemon is started detached (no TTY) and credentials are missing, we cannot safely
  // run the interactive auth selector UI. In that case, fail fast and let the parent/orchestrator
  // run `happy auth login` in an interactive terminal.
  if (!isInteractive) {
    const credentials = await readCredentials();
    if (!credentials) {
      logger.debug('[AUTH] No credentials found');
      logger.debug('[DAEMON RUN] Non-interactive mode: refusing to start auth UI. Run: happy auth login');
      process.exit(1);
    }
  }

  let daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>> = null;

  try {
    // Ensure auth and machine registration BEFORE we take the daemon lock.
    // This prevents stuck lock files when auth is interrupted or cannot proceed.
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Acquire exclusive lock (proves daemon is running)
    daemonLockHandle = await acquireDaemonLock(5, 200);
    if (!daemonLockHandle) {
      logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
      process.exit(0);
    }

    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

	    // Setup state - key by PID
	    const pidToTrackedSession = new Map<number, TrackedSession>();
	    const spawnResourceCleanupByPid = new Map<number, () => void>();
	    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
	    let apiMachineForSessions: ApiMachineClient | null = null;

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

	    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

	    // Handle webhook from happy session reporting itself
	    const onHappySessionWebhook = createOnHappySessionWebhook({ pidToTrackedSession, pidToAwaiter });

	    // Spawn a new session (sessionId reserved for future Happy session resume; vendor resume uses options.resume).
		    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
	      // Do NOT log raw options: it may include secrets (token / env vars).
	      const envKeysPreview = options.environmentVariables && typeof options.environmentVariables === 'object'
	        ? Object.keys(options.environmentVariables as Record<string, unknown>)
	        : [];
	      const environmentVariablesValidation = validateEnvVarRecordStrict(options.environmentVariables);
	      logger.debugLargeJson('[DAEMON RUN] Spawning session', {
	        directory: options.directory,
	        sessionId: options.sessionId,
	        machineId: options.machineId,
	        approvedNewDirectoryCreation: options.approvedNewDirectoryCreation,
	        agent: options.agent,
	        profileId: options.profileId,
	        hasToken: !!options.token,
	        hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
	        environmentVariableCount: envKeysPreview.length,
	        environmentVariableKeys: envKeysPreview,
	        environmentVariablesValid: environmentVariablesValidation.ok,
	        environmentVariablesError: environmentVariablesValidation.ok ? null : environmentVariablesValidation.error,
	      });

	      if (!environmentVariablesValidation.ok) {
	        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
            errorMessage: environmentVariablesValidation.error,
          };
	      }

			      const {
			        directory,
			        sessionId,
			        machineId,
			        approvedNewDirectoryCreation = true,
			        resume,
			        existingSessionId,
			        sessionEncryptionKeyBase64,
			        sessionEncryptionVariant,
			        permissionMode,
			        permissionModeUpdatedAt,
			        experimentalCodexResume,
			        experimentalCodexAcp
			      } = options;
		      const normalizedResume = typeof resume === 'string' ? resume.trim() : '';
		      const normalizedExistingSessionId = typeof existingSessionId === 'string' ? existingSessionId.trim() : '';

	      // Idempotency: a resume request should not spawn a duplicate process when the session is already running.
	      // This is especially important for pending-queue wake-ups, where the UI may attempt a best-effort wake
	      // even if a session is already attached.
		      if (normalizedExistingSessionId) {
		        const existingTracked = await findRunningTrackedSessionById({
		          sessions: pidToTrackedSession.values(),
		          happySessionId: normalizedExistingSessionId,
	          isPidAlive: async (pid) => {
	            try {
	              process.kill(pid, 0);
	              return true;
	            } catch {
	              return false;
	            }
	          },
	          getProcessCommandHash: async (pid) => {
	            const proc = await findHappyProcessByPid(pid);
	            return proc?.command ? hashProcessCommand(proc.command) : null;
	          },
	        });
	        if (existingTracked) {
	          logger.debug(`[DAEMON RUN] Resume requested for ${normalizedExistingSessionId}, but session is already running (pid=${existingTracked.pid})`);
		          return { type: 'success', sessionId: normalizedExistingSessionId };
		        }
		      }
		      const effectiveResume = normalizedResume;
          const catalogAgentId = resolveCatalogAgentId(options.agent ?? null);

		      // Only gate vendor resume. Happy-session reconnect (existingSessionId) is supported for all agents.
		      if (effectiveResume) {
            const vendorResumeSupport = await getVendorResumeSupport(options.agent ?? null);
            const ok = vendorResumeSupport({ experimentalCodexResume, experimentalCodexAcp });
            if (!ok) {
              const supportLevel = AGENTS[catalogAgentId].vendorResumeSupport;
              const qualifier = supportLevel === 'experimental' ? ' (experimental and not enabled)' : '';
		        return {
		          type: 'error',
              errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
		          errorMessage: `Resume is not supported for agent '${catalogAgentId}'${qualifier}.`,
		        };
            }
		      }

		      const normalizedSessionEncryptionKeyBase64 =
		        typeof sessionEncryptionKeyBase64 === 'string' ? sessionEncryptionKeyBase64.trim() : '';
		      if (normalizedExistingSessionId) {
		        if (!normalizedSessionEncryptionKeyBase64) {
		          return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
                errorMessage: 'Missing session encryption key for resume',
              };
		        }
		        if (sessionEncryptionVariant !== 'dataKey') {
		          return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_UNSUPPORTED_ENCRYPTION_VARIANT,
                errorMessage: 'Unsupported session encryption variant for resume',
              };
		        }
		      }
		      let directoryCreated = false;

          const daemonSpawnHooks = AGENTS[catalogAgentId].getDaemonSpawnHooks
            ? await AGENTS[catalogAgentId].getDaemonSpawnHooks!()
            : null;

		      let spawnResourceCleanupOnFailure: (() => void) | null = null;
		      let spawnResourceCleanupOnExit: (() => void) | null = null;
		      let spawnResourceCleanupArmed = false;
		      let sessionAttachCleanup: (() => Promise<void>) | null = null;

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
            errorCode: SPAWN_SESSION_ERROR_CODES.DIRECTORY_CREATE_FAILED,
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
          if (daemonSpawnHooks?.buildAuthEnv) {
            const built = await daemonSpawnHooks.buildAuthEnv({ token: options.token });
            Object.assign(authEnv, built.env);
            spawnResourceCleanupOnFailure = built.cleanupOnFailure ?? null;
            spawnResourceCleanupOnExit = built.cleanupOnExit ?? null;
          } else {
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        // Layer 2: Profile environment variables
        // IMPORTANT: only apply profile env when explicitly provided by the caller.
        // We do NOT fall back to CLI-local active profile here, because sessions spawned via
        // the daemon are typically requested by the GUI and must respect GUI opt-in gating.
        let profileEnv: Record<string, string> = {};

        if (Object.keys(environmentVariablesValidation.env).length > 0) {
          // GUI provided profile environment variables - highest priority for profile settings
          profileEnv = environmentVariablesValidation.env;
          logger.info(`[DAEMON RUN] Using GUI-provided profile environment variables (${Object.keys(profileEnv).length} vars)`);
          logger.debug(`[DAEMON RUN] GUI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
        } else {
          logger.debug('[DAEMON RUN] No profile environment variables provided by caller; skipping profile env injection');
        }
        // Session identity (non-secret) for cross-device display/debugging
        // Empty string means "no profile" and should still be preserved.
        const sessionProfileEnv: Record<string, string> = {};
        if (options.profileId !== undefined) {
          sessionProfileEnv.HAPPY_SESSION_PROFILE_ID = options.profileId;
        }

        // Final merge: profile vars + session identity, then auth (auth takes precedence to protect authentication)
        let extraEnv = { ...profileEnv, ...sessionProfileEnv, ...authEnv };
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
          if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
            spawnResourceCleanupOnFailure();
            spawnResourceCleanupOnFailure = null;
            spawnResourceCleanupOnExit = null;
          }
          return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED,
            errorMessage
          };
        }

        const cleanupSpawnResources = () => {
          if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
            spawnResourceCleanupOnFailure();
            spawnResourceCleanupOnFailure = null;
            spawnResourceCleanupOnExit = null;
          }
        };

        if (daemonSpawnHooks?.validateSpawn) {
          const validation = await daemonSpawnHooks.validateSpawn({ experimentalCodexResume, experimentalCodexAcp });
          if (!validation.ok) {
            cleanupSpawnResources();
            return {
              type: 'error',
              errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
              errorMessage: validation.errorMessage,
            };
          }
        }

	        const terminalRequest = resolveTerminalRequestFromSpawnOptions({
	          happyHomeDir: configuration.happyHomeDir,
	          terminal: options.terminal,
	          environmentVariables: extraEnv,
	        });

	        // Remove tmux control env vars from the spawned agent process.
	        // TMUX_SESSION_NAME is Happy-specific; TMUX_TMPDIR is a daemon/runtime concern.
	        const extraEnvForChild = { ...extraEnv };
	        delete extraEnvForChild.TMUX_SESSION_NAME;
	        delete extraEnvForChild.TMUX_TMPDIR;
          if (daemonSpawnHooks?.buildExtraEnvForChild) {
            Object.assign(
              extraEnvForChild,
              daemonSpawnHooks.buildExtraEnvForChild({ experimentalCodexResume, experimentalCodexAcp }),
            );
          }
	        let sessionAttachFilePath: string | null = null;
	        if (normalizedExistingSessionId) {
	          const attach = await createSessionAttachFile({
	            happySessionId: normalizedExistingSessionId,
	            payload: {
	              encryptionKeyBase64: normalizedSessionEncryptionKeyBase64,
	              encryptionVariant: 'dataKey',
	            },
	          });
	          sessionAttachFilePath = attach.filePath;
	          sessionAttachCleanup = attach.cleanup;
	        }

	        const extraEnvForChildWithMessage = sessionAttachFilePath
	          ? { ...extraEnvForChild, HAPPY_SESSION_ATTACH_FILE: sessionAttachFilePath }
	          : extraEnvForChild;

	        // Check if tmux is available and should be used
	        const tmuxAvailable = await isTmuxAvailable();
	        const tmuxRequested = terminalRequest.requested === 'tmux';
	        let useTmux = tmuxAvailable && tmuxRequested;

	        const tmuxSessionName = tmuxRequested ? terminalRequest.tmux.sessionName : undefined;
	        const tmuxTmpDir = tmuxRequested ? terminalRequest.tmux.tmpDir : null;
	        const tmuxCommandEnv: Record<string, string> = {};
	        if (tmuxTmpDir) {
	          tmuxCommandEnv.TMUX_TMPDIR = tmuxTmpDir;
	        }

	        let tmuxFallbackReason: string | null = null;

	        if (!tmuxAvailable && tmuxRequested) {
	          tmuxFallbackReason = 'tmux is not available on this machine';
	          logger.debug('[DAEMON RUN] tmux requested but tmux is not available; falling back to regular spawning');
	        }

	        if (useTmux && tmuxSessionName !== undefined) {
	          // Resolve empty-string session name (legacy "current/most recent") deterministically.
	          let resolvedTmuxSessionName = tmuxSessionName;
	          if (tmuxSessionName === '') {
	            try {
	              const tmuxForDiscovery = new TmuxUtilities(undefined, tmuxCommandEnv);
	              const listResult = await tmuxForDiscovery.executeTmuxCommand([
	                'list-sessions',
	                '-F',
	                '#{session_name}\t#{session_attached}\t#{session_last_attached}',
	              ]);
	              resolvedTmuxSessionName =
	                selectPreferredTmuxSessionName(listResult?.stdout ?? '') ?? TmuxUtilities.DEFAULT_SESSION_NAME;
	            } catch (error) {
	              logger.debug('[DAEMON RUN] Failed to resolve current/most-recent tmux session; defaulting to "happy"', error);
	              resolvedTmuxSessionName = TmuxUtilities.DEFAULT_SESSION_NAME;
	            }
	          }

	          // Try to spawn in tmux session
	          const sessionDesc = resolvedTmuxSessionName || 'current/most recent session';
	          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

	          const agentSubcommand = resolveAgentCliSubcommand(options.agent);
	          const windowName = `happy-${Date.now()}-${agentSubcommand}`;
	          const tmuxTarget = `${resolvedTmuxSessionName}:${windowName}`;

	          const terminalRuntimeArgs = [
	            '--happy-terminal-mode',
	            'tmux',
	            '--happy-terminal-requested',
	            'tmux',
	            '--happy-tmux-target',
	            tmuxTarget,
	            ...(tmuxTmpDir ? ['--happy-tmux-tmpdir', tmuxTmpDir] : []),
	          ];

		          const { commandTokens, tmuxEnv } = buildTmuxSpawnConfig({
		            agent: agentSubcommand,
		            directory,
		            extraEnv: extraEnvForChildWithMessage,
		            tmuxCommandEnv,
		            extraArgs: [
		              ...terminalRuntimeArgs,
		              ...(permissionMode ? ['--permission-mode', permissionMode] : []),
		              ...(typeof permissionModeUpdatedAt === 'number'
		                ? ['--permission-mode-updated-at', `${permissionModeUpdatedAt}`]
		                : []),
		              ...(effectiveResume ? ['--resume', effectiveResume] : []),
		              ...(normalizedExistingSessionId ? ['--existing-session', normalizedExistingSessionId] : []),
		            ],
		          });
	          const tmux = new TmuxUtilities(resolvedTmuxSessionName, tmuxCommandEnv);

          // Spawn in tmux with environment variables
          // IMPORTANT: `spawnInTmux` uses `-e KEY=VALUE` flags for the window.
          // Use merged env so tmux mode matches regular process spawn behavior.
          // Note: this may add many `-e` flags; if it becomes a problem we can optimize
          // by diffing against `tmux show-environment` in a follow-up.
	          if (tmuxTmpDir) {
	            try {
	              await fs.mkdir(tmuxTmpDir, { recursive: true });
	            } catch (error) {
	              logger.debug('[DAEMON RUN] Failed to ensure TMUX_TMPDIR exists; tmux may fail to start', error);
	            }
	          }

	          const tmuxResult = await tmux.spawnInTmux(commandTokens, {
	            sessionName: resolvedTmuxSessionName,
	            windowName: windowName,
	            cwd: directory
	          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Resolve the actual tmux session name used (important when sessionName was empty/undefined)
            const tmuxSession = tmuxResult.sessionName ?? (resolvedTmuxSessionName || 'happy');

	            // Create a tracked session for tmux windows - now we have the real PID!
	            const trackedSession: TrackedSession = {
	              startedBy: 'daemon',
	              pid: tmuxResult.pid, // Real PID from tmux -P flag
	              tmuxSessionId: tmuxResult.sessionId,
	              vendorResumeId: effectiveResume || undefined,
	              directoryCreated,
	              message: directoryCreated
	                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
	                : `Spawned new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
	            };

	            // Add to tracking map so webhook can find it later
	            pidToTrackedSession.set(tmuxResult.pid, trackedSession);
	            if (spawnResourceCleanupOnExit) {
	              spawnResourceCleanupByPid.set(tmuxResult.pid, spawnResourceCleanupOnExit);
	              spawnResourceCleanupArmed = true;
	            }
	            if (sessionAttachCleanup) {
	              sessionAttachCleanupByPid.set(tmuxResult.pid, sessionAttachCleanup);
	              sessionAttachCleanup = null;
	            }

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

          return new Promise((resolve) => {
            // Set timeout for webhook (same as regular flow)
            const timeout = setTimeout(() => {
              pidToAwaiter.delete(tmuxResult.pid!);
              pidToSpawnResultResolver.delete(tmuxResult.pid!);
              pidToSpawnWebhookTimeout.delete(tmuxResult.pid!);
              logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.pid} (tmux)`);
              resolve({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
              });
            }, 15_000); // Same timeout as regular sessions
            pidToSpawnWebhookTimeout.set(tmuxResult.pid!, timeout);

            // Register awaiter for tmux session (exact same as regular flow)
            pidToAwaiter.set(tmuxResult.pid!, (completedSession) => {
              clearTimeout(timeout);
              pidToSpawnWebhookTimeout.delete(tmuxResult.pid!);
              pidToSpawnResultResolver.delete(tmuxResult.pid!);
              logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
              resolve({
                type: 'success',
                sessionId: completedSession.happySessionId!
              });
            });
          });
	          } else {
	            tmuxFallbackReason = tmuxResult.error ?? 'tmux spawn failed';
	            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
	            useTmux = false;
	          }
	        }
	
	        // Regular process spawning (fallback or if tmux not available)
	        if (!useTmux) {
	          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          const agentCommand = resolveAgentCliSubcommand(options.agent);
	          const args = [
	            agentCommand,
	            '--happy-starting-mode', 'remote',
	            '--started-by', 'daemon'
	          ];

	          if (tmuxRequested) {
	            const reason = tmuxFallbackReason ?? 'tmux was not used';
	            args.push(
	              '--happy-terminal-mode',
	              'plain',
              '--happy-terminal-requested',
              'tmux',
	              '--happy-terminal-fallback-reason',
	              reason,
	            );
	          }

		          if (effectiveResume) {
		            args.push('--resume', effectiveResume);
		          }
		          if (normalizedExistingSessionId) {
		            args.push('--existing-session', normalizedExistingSessionId);
		          }
		          if (permissionMode) {
		            args.push('--permission-mode', permissionMode);
		          }
		          if (typeof permissionModeUpdatedAt === 'number') {
		            args.push('--permission-mode-updated-at', `${permissionModeUpdatedAt}`);
		          }

	          // NOTE: sessionId is reserved for future Happy session resume; we currently ignore it.
	          const happyProcess = spawnHappyCLI(args, {
	            cwd: directory,
	            detached: true,  // Sessions stay alive when daemon stops
	            stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
	            env: {
	              ...process.env,
	              ...extraEnvForChildWithMessage
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
	            if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
	              spawnResourceCleanupOnFailure();
	              spawnResourceCleanupOnFailure = null;
	              spawnResourceCleanupOnExit = null;
	            }
	            if (sessionAttachCleanup) {
	              await sessionAttachCleanup();
	              sessionAttachCleanup = null;
	            }
	            return {
	              type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
	              errorMessage: 'Failed to spawn Happy process - no PID returned'
	            };
	          }

	          logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);
	          if (sessionAttachCleanup) {
	            sessionAttachCleanupByPid.set(happyProcess.pid, sessionAttachCleanup);
	            sessionAttachCleanup = null;
	          }

	          const trackedSession: TrackedSession = {
	            startedBy: 'daemon',
	            pid: happyProcess.pid,
	            childProcess: happyProcess,
	            vendorResumeId: effectiveResume || undefined,
	            directoryCreated,
	            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
	          };

          pidToTrackedSession.set(happyProcess.pid, trackedSession);
          if (spawnResourceCleanupOnExit) {
            spawnResourceCleanupByPid.set(happyProcess.pid, spawnResourceCleanupOnExit);
            spawnResourceCleanupArmed = true;
          }

          happyProcess.on('exit', (code, signal) => {
            logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
            if (happyProcess.pid) {
              const resolveSpawn = pidToSpawnResultResolver.get(happyProcess.pid);
              if (resolveSpawn) {
                pidToSpawnResultResolver.delete(happyProcess.pid);
                const timeout = pidToSpawnWebhookTimeout.get(happyProcess.pid);
                if (timeout) clearTimeout(timeout);
                pidToSpawnWebhookTimeout.delete(happyProcess.pid);
                pidToAwaiter.delete(happyProcess.pid);
                resolveSpawn({
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
                  errorMessage: `Child process exited before session webhook (pid=${happyProcess.pid}, code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
                });
              }
              onChildExited(happyProcess.pid, { reason: 'process-exited', code, signal });
            }
          });

          happyProcess.on('error', (error) => {
            logger.debug(`[DAEMON RUN] Child process error:`, error);
            if (happyProcess.pid) {
              const resolveSpawn = pidToSpawnResultResolver.get(happyProcess.pid);
              if (resolveSpawn) {
                pidToSpawnResultResolver.delete(happyProcess.pid);
                const timeout = pidToSpawnWebhookTimeout.get(happyProcess.pid);
                if (timeout) clearTimeout(timeout);
                pidToSpawnWebhookTimeout.delete(happyProcess.pid);
                pidToAwaiter.delete(happyProcess.pid);
                resolveSpawn({
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
                  errorMessage: `Child process error before session webhook (pid=${happyProcess.pid})`,
                });
              }
              onChildExited(happyProcess.pid, { reason: 'process-error', code: null, signal: null });
            }
          });

          // Wait for webhook to populate session with happySessionId
          logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

          return new Promise((resolve) => {
            pidToSpawnResultResolver.set(happyProcess.pid!, resolve);
            // Set timeout for webhook
            const timeout = setTimeout(() => {
              pidToAwaiter.delete(happyProcess.pid!);
              pidToSpawnResultResolver.delete(happyProcess.pid!);
              pidToSpawnWebhookTimeout.delete(happyProcess.pid!);
              logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
              resolve({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                errorMessage: `Session webhook timeout for PID ${happyProcess.pid}`
              });
              // 15 second timeout - I have seen timeouts on 10 seconds
              // even though session was still created successfully in ~2 more seconds
            }, 15_000);
            pidToSpawnWebhookTimeout.set(happyProcess.pid!, timeout);

            // Register awaiter
            pidToAwaiter.set(happyProcess.pid!, (completedSession) => {
              clearTimeout(timeout);
              pidToSpawnWebhookTimeout.delete(happyProcess.pid!);
              pidToSpawnResultResolver.delete(happyProcess.pid!);
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
          errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: 'Unexpected error in session spawning'
        };
	      } catch (error) {
	        if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
	          spawnResourceCleanupOnFailure();
	          spawnResourceCleanupOnFailure = null;
	          spawnResourceCleanupOnExit = null;
	        }
	        if (sessionAttachCleanup) {
	          await sessionAttachCleanup();
	          sessionAttachCleanup = null;
	        }
	        const errorMessage = error instanceof Error ? error.message : String(error);
	        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
	        return {
	          type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
	          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

	    const stopSession = createStopSession({ pidToTrackedSession });

	    // Handle child process exit
	    const onChildExited = createOnChildExited({
	      pidToTrackedSession,
	      spawnResourceCleanupByPid,
	      sessionAttachCleanupByPid,
	      getApiMachineForSessions: () => apiMachineForSessions,
	    });

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
    const preferredHostForRegistration = await getPreferredHostName();
    const metadataForRegistration: MachineMetadata = { ...initialMachineMetadata, host: preferredHostForRegistration };
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: metadataForRegistration,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);
    apiMachineForSessions = apiMachine;

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      requestShutdown: () => requestShutdown('happy-app')
    });

    // Connect to server
    const preferredHost = await getPreferredHostName();
    let didRefreshMachineMetadata = false;
    apiMachine.connect({
      onConnect: async () => {
        if (didRefreshMachineMetadata) return;

        // Keep machine metadata fresh without clobbering user-provided fields (e.g. displayName) that may exist.
        await apiMachine.updateMachineMetadata((metadata) => {
          const base = (metadata ?? (machine.metadata as any) ?? {}) as any;
          const next: MachineMetadata = {
            ...base,
            host: preferredHost,
            platform: os.platform(),
            happyCliVersion: packageJson.version,
            homeDir: os.homedir(),
            happyHomeDir: configuration.happyHomeDir,
            happyLibDir: projectPath(),
          } as MachineMetadata;

          // If nothing changes, skip emitting an update entirely.
          const current = base as Partial<MachineMetadata>;
          const isSame =
            current.host === next.host &&
            current.platform === next.platform &&
            current.happyCliVersion === next.happyCliVersion &&
            current.homeDir === next.homeDir &&
            current.happyHomeDir === next.happyHomeDir &&
            current.happyLibDir === next.happyLibDir;

          if (isSame) {
            return base as MachineMetadata;
          }

          return next;
        });

        didRefreshMachineMetadata = true;
      },
    });

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const restartOnStaleVersionAndHeartbeat = startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachineForSessions,
      controlPort,
      fileState,
      currentCliVersion: configuration.currentCliVersion,
      requestShutdown,
    });

	    // Setup signal handlers
	    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
	      const exitCode = getDaemonShutdownExitCode(source);
	      const shutdownWatchdog = setTimeout(async () => {
	        logger.debug(`[DAEMON RUN] Shutdown timed out, forcing exit with code ${exitCode}`);
	        await new Promise((resolve) => setTimeout(resolve, 100));
	        process.exit(exitCode);
	      }, getDaemonShutdownWatchdogTimeoutMs());
	      shutdownWatchdog.unref?.();

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
	      if (daemonLockHandle) {
	        await releaseDaemonLock(daemonLockHandle);
	      }

	      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
	      clearTimeout(shutdownWatchdog);
	      process.exit(exitCode);
	    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    try {
      if (daemonLockHandle) {
        await releaseDaemonLock(daemonLockHandle);
      }
    } catch {
      // ignore
    }
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
